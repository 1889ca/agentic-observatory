# Autonomy Boost and Approval Learning

> Progressive auto-approval based on learned user behavior patterns, where repeated approval of similar actions teaches the system to skip confirmation for trusted action types.

## Problem

Agent systems that require approval for every action create friction that defeats the purpose of automation. Users end up clicking "approve" dozens of times for routine operations they always allow. But removing approvals entirely is dangerous — users need guardrails for unfamiliar or high-risk actions. The challenge is distinguishing between actions the user *always* approves (and would prefer to skip) and actions that genuinely need review.

## Context

- An agent system with a human-in-the-loop approval step for tool execution
- Users repeatedly approve the same types of actions (running tests, reading files, querying databases)
- Different users have different approval patterns — what's routine for one may be risky for another
- The system needs to be conservative by default and earn autonomy over time
- A single denial should override accumulated trust — false positives are much worse than false negatives

## Solution

### Action Fingerprinting

Each action is reduced to a fingerprint that captures its essential identity — the tool name, argument patterns (not exact values), and domain context. This allows the system to recognize "running npm test in project X" as a category, not just a single event:

```javascript
// lib/agent/autonomy-boost/fingerprint.js
function createFingerprint(toolName, args, context) {
  const argPatterns = {};

  for (const [key, value] of Object.entries(args)) {
    // Capture shape, not exact values
    if (typeof value === 'string' && value.length > 50) {
      argPatterns[key] = 'long_string';
    } else if (typeof value === 'string') {
      argPatterns[key] = value; // Short strings are kept (e.g., command names)
    } else {
      argPatterns[key] = typeof value;
    }
  }

  return {
    toolName,
    argPatterns,
    domain: context.project || context.domain || 'global',
    hash: hashObject({ toolName, argPatterns, domain: context.project }),
  };
}

function hashObject(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}
```

### Approval History Tracking

Every approval or denial is recorded against the action's fingerprint hash. The history provides the data for auto-approval decisions:

```javascript
// lib/agent/autonomy-boost/history.js
async function recordApproval(fingerprintHash, approved) {
  await db.query(
    `INSERT INTO approval_history (fingerprint_hash, approved, timestamp)
     VALUES ($1, $2, NOW())`,
    [fingerprintHash, approved]
  );

  // If denied, reset the consecutive approval counter immediately
  if (!approved) {
    await db.query(
      `UPDATE approval_counters SET consecutive_approvals = 0, last_denied_at = NOW()
       WHERE fingerprint_hash = $1`,
      [fingerprintHash]
    );
  } else {
    await db.query(
      `INSERT INTO approval_counters (fingerprint_hash, consecutive_approvals, last_approved_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (fingerprint_hash) DO UPDATE
       SET consecutive_approvals = approval_counters.consecutive_approvals + 1,
           last_approved_at = NOW()`,
      [fingerprintHash]
    );
  }
}
```

### Auto-Approval Decision

When an action is about to be executed, the system checks whether it qualifies for auto-approval. The threshold is configurable, and a single denial resets the counter:

```javascript
// lib/agent/autonomy-boost/decide.js
const AUTO_APPROVE_THRESHOLD = parseInt(process.env.AUTO_APPROVE_THRESHOLD) || 5;

async function shouldAutoApprove(fingerprint) {
  const counter = await db.query(
    'SELECT consecutive_approvals, last_denied_at FROM approval_counters WHERE fingerprint_hash = $1',
    [fingerprint.hash]
  );

  if (counter.rows.length === 0) return false;

  const { consecutive_approvals, last_denied_at } = counter.rows[0];

  // Must meet threshold
  if (consecutive_approvals < AUTO_APPROVE_THRESHOLD) return false;

  // If there's a recent denial, require more consecutive approvals to rebuild trust
  if (last_denied_at) {
    const approvalsSinceDenial = await db.query(
      `SELECT COUNT(*) as count FROM approval_history
       WHERE fingerprint_hash = $1 AND approved = true AND timestamp > $2`,
      [fingerprint.hash, last_denied_at]
    );

    if (parseInt(approvalsSinceDenial.rows[0].count) < AUTO_APPROVE_THRESHOLD) return false;
  }

  return true;
}
```

### Integration with Tool Execution

The approval check sits in the tool execution pipeline, between action planning and execution. If auto-approved, the user sees a brief notification instead of a blocking prompt:

```javascript
// lib/agent/execute-with-approval.js
async function executeWithApproval(tool, args, context) {
  const fingerprint = createFingerprint(tool.name, args, context);
  const autoApproved = await shouldAutoApprove(fingerprint);

  if (autoApproved) {
    context.notify(`Auto-approved: ${tool.name} (based on your history)`);
    const result = await tool.execute(args);
    await recordApproval(fingerprint.hash, true);
    return result;
  }

  // Requires explicit approval
  const approved = await context.requestApproval({
    tool: tool.name,
    args,
    fingerprint,
  });

  await recordApproval(fingerprint.hash, approved);

  if (!approved) {
    return { rejected: true, tool: tool.name };
  }

  return tool.execute(args);
}
```

### Batch Approval

When multiple pending actions share similar fingerprints, they are grouped for bulk approve/deny. This reduces friction for repetitive workflows:

```javascript
// lib/agent/batch-approval.js
function groupForBatchApproval(pendingActions) {
  const groups = new Map();

  for (const action of pendingActions) {
    const fingerprint = createFingerprint(action.tool, action.args, action.context);
    const key = fingerprint.hash;

    if (!groups.has(key)) {
      groups.set(key, {
        fingerprint,
        description: `${action.tool} (${fingerprint.domain})`,
        actions: [],
      });
    }
    groups.get(key).actions.push(action);
  }

  return Array.from(groups.values());
}

async function batchApprove(group, approved) {
  for (const action of group.actions) {
    await recordApproval(group.fingerprint.hash, approved);

    if (approved) {
      await action.tool.execute(action.args);
    }
  }
}
```

## Implications

- Conservative by default — new action types always require explicit approval until the threshold is met
- A single denial resets the counter, making the system strongly biased toward safety over convenience
- Fingerprinting by argument patterns (not exact values) allows generalization — approving `npm test` once in a project teaches the system about `npm test` in that project, not just that specific invocation
- The `domain` field in fingerprints means approval learning is project-scoped — approving `rm` in a test project doesn't auto-approve `rm` in production
- Auto-approval notifications are important UX — users must know when the system acts on their behalf, even if they don't need to confirm
- Batch approval reduces friction for bulk operations but requires careful grouping to avoid accidentally approving unrelated actions
- This pattern is distinct from confidence-based autonomy gating, which operates at the domain level. This is action-pattern-level learning that adapts to individual user behavior

## Code Example

```javascript
// Typical flow: user approves "npm test" in project riley 5 times, then it auto-approves

// First 5 times: explicit approval prompt
// User: "run the tests"
// Agent: [Requesting approval] Run npm test in /projects/riley
// User: [Approve]

// 6th time onwards: auto-approved
// User: "run the tests"
// Agent: Auto-approved: npm_test (based on your history)
// [tests run immediately]

// If user ever denies:
// User: "run the tests" (but they changed their mind about auto-approving)
// Agent: [Requesting approval] Run npm test in /projects/riley
// User: [Deny]
// Counter resets — next 5 approvals needed to re-earn auto-approval
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Implicit Approval Parsing](./implicit-approval-parsing.md)
