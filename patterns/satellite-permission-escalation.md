# Satellite Permission Escalation

> Handling permission boundaries in multi-agent dispatch so blocked workers report why, not just that they failed.

## Problem

When an orchestrator dispatches work to AI agent workers (e.g., Claude Code instances), those workers operate within permission boundaries — tool restrictions, file access limits, network constraints, approval gates. From the orchestrator's perspective, a permission block is indistinguishable from a crash or timeout: the worker simply stops producing output. This creates silent failures where the orchestrator retries work that can never succeed, wastes worker slots, and has no diagnostic signal to inform alternative strategies.

## Context

- Multi-agent systems where an orchestrator dispatches tasks to AI agent workers
- Workers running with varying permission configurations (full auto-accept, selective approval, manual-only)
- Long-running tasks that span multiple tool categories (file reads, writes, shell execution, network access)
- Workers that cannot programmatically grant themselves additional permissions mid-session
- Need to distinguish between "worker is stuck on permissions" and "worker crashed" and "worker is just slow"

## Solution

### Integrated Permission Checking in the Dispatch Cycle

Permission escalation is part of the orchestrator's dispatch cycle, not an isolated flow. Before dispatching work, the orchestrator evaluates required permissions and uses confidence score thresholds (via `deliberative-alignment.js`) to gate escalation decisions:

- Score >= 0.85: Auto-execute (high confidence)
- Score >= 0.60: Execute with notification
- Score >= 0.40: Execute with caution, log for review
- Score < 0.40: Escalate to human

```javascript
// Permission check integrated into dispatch planning
// Confidence thresholds via deliberative-alignment.js
async function planDispatch(job) {
  const requiredPerms = job.requiredPermissions ?? ['read'];
  const worker = findCompatibleWorker(job);

  if (worker) {
    // Worker has all required permissions — dispatch based on confidence score
    const confidence = await assessConfidence(job);
    if (confidence < 0.40) {
      await requestApproval({ job, reason: `Low confidence (${confidence}) — requires human approval` });
    }
    return { action: 'dispatch', worker, confidence };
  }

  // No compatible worker — escalate permission request
  const missing = getMissingPermissions(job);
  return { action: 'escalate', missing, job };
}
```

### Permission Requirement Declaration

Task definitions declare expected permission categories upfront. The orchestrator validates compatibility before dispatch, bundling permission requests with approval workflows:

```javascript
const task = {
  id: 'apply-fixes',
  prompt: 'Apply the suggested code fixes',
  requiredPermissions: ['read', 'edit', 'write', 'bash'],
};

function canWorkerHandle(worker, task) {
  const workerPermissions = worker.permissionProfile;
  const missing = task.requiredPermissions.filter(
    p => !workerPermissions.includes(p)
  );
  if (missing.length > 0) {
    return { compatible: false, missing };
  }
  return { compatible: true };
}
```

### Stall Detection

Workers that hit permission prompts don't crash — they hang waiting for input. The orchestrator detects this via activity monitoring, not just exit codes:

```javascript
function detectStalls(activeJobs) {
  const now = Date.now();
  for (const job of activeJobs) {
    const silentDuration = now - job.lastActivityAt;

    if (silentDuration > STALL_THRESHOLD_MS) {
      job.status = 'suspected_permission_block';
      emitAlert(job);
    }
  }
}

setInterval(() => detectStalls(getActiveJobs()), 60000);
```

### Structured Failure Reporting

Workers communicate **why** they're blocked, not just that they're blocked. A failure taxonomy distinguishes permission blocks from other failure modes:

```javascript
function reportFailure(jobId, failure) {
  return {
    jobId,
    status: 'blocked',
    reason: failure.type,     // 'permission_denied' | 'timeout' | 'crash' | 'resource_limit'
    detail: failure.message,  // 'Write access to /etc/nginx required'
    toolCategory: failure.tool, // 'bash' | 'edit' | 'write' | 'network'
    recoverable: failure.recoverable,
  };
}
```

### Confidence-Gated Fallback Strategies

When a permission block is detected, the fallback strategy is gated by the confidence score from `deliberative-alignment.js`:

- **>= 0.85 (high confidence)**: Silently retry with an elevated worker or decompose the task into safer sub-steps
- **>= 0.60 (moderate confidence)**: Execute fallback and notify human after the fact
- **>= 0.40 (low confidence)**: Execute with caution, log the recovery action for review
- **< 0.40 (very low confidence)**: Block and request human approval before attempting recovery

```javascript
async function handlePermissionBlock(job, failure) {
  const confidence = await assessConfidence(job);

  if (confidence < 0.40) {
    // Very low confidence — always escalate to human for approval
    return await escalateToHuman(job, {
      reason: `Worker needs ${failure.toolCategory} access: ${failure.detail}`,
      confidence,
      suggestion: 'Approve elevated permissions or apply changes manually',
    });
  }

  // Confidence >= 0.40 — attempt automatic recovery
  const result = await decomposeOrRedispatch(job, failure);

  if (confidence < 0.85) {
    // Moderate/low confidence — notify human about the recovery action
    await sendNotification({ job, failure, recovery: result, confidence });
  }

  return result;
}
```

## Implications

- Stall detection has inherent latency (polling interval) — fast-failing is preferable but not always possible with interactive permission models
- Pre-dispatch permission checking requires upfront declaration of expected tool usage, adding authoring overhead to task definitions
- No way to programmatically grant permissions mid-session in most AI agent runtimes — blocked workers must be restarted with new config
- The decomposition strategy (breaking tasks into smaller steps) may produce worse results than a single cohesive execution
- Human escalation requires a notification system and queue — adds infrastructure beyond the orchestrator itself
- Permission profiles vary by runtime (Claude Code, OpenAI Codex, etc.) — the abstraction layer must account for different permission models

## Code Example

```javascript
// Permission-aware dispatch cycle with confidence-based gating
async function dispatchWithPermissionHandling(job, maxRetries = 2) {
  const plan = await planDispatch(job);

  if (plan.action === 'escalate') {
    // No compatible worker — escalate based on confidence score
    return await handlePermissionBlock(job, {
      type: 'permission_denied',
      toolCategory: plan.missing[0],
      message: `No worker with permissions: ${plan.missing.join(', ')}`,
      recoverable: false,
    });
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await dispatchAndMonitor(plan.worker, job);

    if (result.status === 'complete') {
      return result;
    }

    if (result.status === 'blocked' && result.reason === 'permission_denied') {
      log(`Job ${job.id} blocked on ${result.toolCategory} (confidence: ${plan.confidence}) — attempt ${attempt + 1}`);

      if (result.recoverable) {
        job.requiredPermissions.push(result.toolCategory);
        continue;
      }

      return await handlePermissionBlock(job, result);
    }

    // Non-permission failure — don't retry
    throw new Error(`Job ${job.id} failed: ${result.detail}`);
  }

  return await escalateToHuman(job, { reason: 'Max retries exceeded on permission blocks' });
}
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Deliberative Alignment](./deliberative-alignment.md)
