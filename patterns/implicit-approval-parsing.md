# Implicit Approval Parsing

> Natural language parsing of simple approval and denial responses so users can approve or reject pending agent actions without structured commands. Batch and qualified approval parsing are designed but not yet implemented.

## Problem

Autonomous agents frequently need human approval before executing consequential actions — deploying to production, sending an email, merging a PR. The typical implementation requires structured commands: `/approve 123`, `!confirm deploy`, or clicking a button in a UI. But humans don't think in commands. They say "yeah go ahead", "ship it", "no wait, hold off on that", or "approve the first two but not the third." Forcing users into rigid command syntax creates friction and breaks conversational flow. The agent should understand natural approval language the same way a human colleague would.

## Context

- An orchestrator with a pending action queue — actions awaiting human approval before execution
- Users communicating through conversational channels (chat, Slack, Telegram)
- Approval responses ranging from simple ("yes") to qualified ("yes but change the timeout first")
- Multiple pending actions that may need individual or batch approval
- The need to avoid false positives — accidentally executing an action because the user said "yes" to something unrelated

## Solution

### Approval Intent Detection

The parser classifies incoming messages into four categories: approve, deny, ambiguous, and not-applicable. It uses keyword matching with guard rails, not an LLM call:

```javascript
// approval-flow.js
const APPROVAL_SIGNALS = [
  'yes', 'yep', 'yeah', 'yup', 'y',
  'go ahead', 'do it', 'go for it', 'ship it',
  'approve', 'approved', 'confirm', 'confirmed',
  'looks good', 'lgtm', 'sounds good',
  'proceed', 'execute', 'run it', 'send it',
  'fine', 'ok', 'okay', 'sure', 'absolutely',
];

const DENIAL_SIGNALS = [
  'no', 'nope', 'nah', 'n',
  'don\'t', 'do not', 'cancel', 'stop',
  'reject', 'rejected', 'deny', 'denied',
  'hold off', 'hold on', 'wait', 'not yet',
  'skip', 'abort', 'never mind', 'nevermind',
];

const AMBIGUOUS_SIGNALS = [
  'maybe', 'perhaps', 'i think so', 'i guess',
  'probably', 'not sure', 'hmm', 'let me think',
];
```

### Context-Gated Activation

The parser only activates when there are pending actions awaiting approval. This prevents false positives — if the user says "yes" in normal conversation with nothing pending, the message flows through to the LLM as usual:

```javascript
// approval-flow.js
function parseApprovalIntent(message, pendingActions) {
  // Gate: only parse if there are actions waiting for approval
  if (!pendingActions || pendingActions.length === 0) {
    return { intent: 'not-applicable' };
  }

  const normalized = message.trim().toLowerCase();

  // Check for ambiguous signals first — these always trigger clarification
  if (matchesAny(normalized, AMBIGUOUS_SIGNALS)) {
    return {
      intent: 'ambiguous',
      message: 'I need a clear yes or no to proceed. Want me to go ahead with this?',
    };
  }

  // Check for batch approval patterns
  const batchResult = parseBatchApproval(normalized, pendingActions);
  if (batchResult) return batchResult;

  // Check for qualified approval
  const qualifiedResult = parseQualifiedApproval(normalized);
  if (qualifiedResult) return qualifiedResult;

  // Simple approval/denial
  if (matchesAny(normalized, APPROVAL_SIGNALS)) {
    return { intent: 'approve', targets: pendingActions.map(a => a.id) };
  }

  if (matchesAny(normalized, DENIAL_SIGNALS)) {
    return { intent: 'deny', targets: pendingActions.map(a => a.id) };
  }

  // No approval-related intent detected — pass through to normal processing
  return { intent: 'not-applicable' };
}
```

Note: The basic yes/no approval and denial parsing above is fully implemented. The batch approval (`parseBatchApproval`) and qualified approval (`parseQualifiedApproval`) functions called in the flow above are designed but not yet implemented -- messages that would match those paths currently fall through to simple approval/denial or `not-applicable`.

### Signal Matching with Boundary Awareness

Keyword matching uses word boundaries to avoid false positives. "yes" matches, but "yesterday" does not. "no" matches, but "note" does not:

```javascript
// approval-flow.js
function matchesAny(text, signals) {
  return signals.some(signal => {
    // Short signals (1-3 chars) must be the entire message or bounded by spaces/punctuation
    if (signal.length <= 3) {
      const pattern = new RegExp(`(^|\\s|^)${escapeRegex(signal)}($|\\s|[.,!?])`, 'i');
      return pattern.test(text);
    }
    // Longer signals can appear anywhere in the message
    return text.includes(signal);
  });
}
```

### Batch Approval Parsing

> **Status: Designed, not yet implemented.** The functions below describe the intended behavior.

Users can approve or deny specific subsets of pending actions by referencing IDs, indices, or descriptions:

```javascript
// approval-flow.js
function parseBatchApproval(text, pendingActions) {
  // "approve all" / "deny all"
  if (/approve\s+all/i.test(text)) {
    return { intent: 'approve', targets: pendingActions.map(a => a.id) };
  }
  if (/(deny|reject|cancel)\s+all/i.test(text)) {
    return { intent: 'deny', targets: pendingActions.map(a => a.id) };
  }

  // "approve #123 and #456" — match by ID
  const idMatches = text.match(/#(\d+)/g);
  if (idMatches) {
    const ids = idMatches.map(m => m.slice(1));
    const matched = pendingActions.filter(a => ids.includes(String(a.id)));

    if (matched.length > 0) {
      const hasApproval = matchesAny(text, APPROVAL_SIGNALS) || /approve/i.test(text);
      const hasDenial = matchesAny(text, DENIAL_SIGNALS) || /reject|deny|cancel/i.test(text);

      return {
        intent: hasApproval ? 'approve' : hasDenial ? 'deny' : 'ambiguous',
        targets: matched.map(a => a.id),
      };
    }
  }

  // "approve the first one" / "approve only the deploy"
  const ordinalResult = parseOrdinalReference(text, pendingActions);
  if (ordinalResult) return ordinalResult;

  // "approve the deploy but not the notification"
  const mixedResult = parseMixedApproval(text, pendingActions);
  if (mixedResult) return mixedResult;

  return null;
}
```

### Qualified Approval Handling

> **Status: Designed, not yet implemented.** The functions below describe the intended behavior.

A qualified approval ("yes but change the timeout first") is detected and routed back to the LLM for interpretation rather than being treated as a simple approval:

```javascript
// approval-flow.js
const QUALIFICATION_MARKERS = ['but', 'except', 'only if', 'as long as', 'first', 'after', 'before', 'change', 'modify', 'update', 'with'];

function parseQualifiedApproval(text) {
  const hasApproval = matchesAny(text, APPROVAL_SIGNALS);
  if (!hasApproval) return null;

  const hasQualification = QUALIFICATION_MARKERS.some(marker => text.includes(marker));
  if (!hasQualification) return null;

  // This is a conditional approval — the LLM needs to interpret the condition
  return {
    intent: 'qualified',
    rawText: text,
    message: 'Detected a conditional approval. Routing to LLM for interpretation.',
  };
}
```

### Pipeline Integration

The approval parser runs as a pre-processing step before the main LLM dispatch. Simple approvals and denials are resolved without an LLM call. Qualified and ambiguous responses are routed through the LLM:

```javascript
// message-processor.js
async function processMessage(message, userId) {
  const pendingActions = await getPendingActions(userId);

  // Pre-LLM: try to resolve as an approval/denial
  const approvalResult = parseApprovalIntent(message.text, pendingActions);

  switch (approvalResult.intent) {
    case 'approve':
      await executeApprovedActions(approvalResult.targets, userId);
      return { text: `Approved and executing ${approvalResult.targets.length} action(s).` };

    case 'deny':
      await cancelPendingActions(approvalResult.targets, userId);
      return { text: `Cancelled ${approvalResult.targets.length} pending action(s).` };

    case 'ambiguous':
      return { text: approvalResult.message };

    case 'qualified':
      // Fall through to LLM with the pending action context attached
      return await dispatchToLLM(message, userId, { pendingActions, qualification: approvalResult.rawText });

    case 'not-applicable':
      // No pending actions or no approval intent — normal message processing
      return await dispatchToLLM(message, userId);
  }
}
```

## Implications

- Pre-LLM parsing avoids burning tokens on simple yes/no responses — approval resolution happens in microseconds with keyword matching instead of milliseconds with an LLM roundtrip
- Context gating (only activating when actions are pending) eliminates false positives from casual "yes" or "no" in normal conversation
- Ambiguous responses are never treated as approvals — this is a deliberate safety choice that trades convenience for correctness. Users must be unambiguous to trigger execution
- Qualified approvals fall through to the LLM, which has the intelligence to interpret conditions like "yes but change the timeout to 30s first" — the parser doesn't try to handle this complexity
- Word boundary matching prevents substring false positives ("yesterday" does not trigger approval), but very short signals like "y" require strict boundary enforcement
- Batch approval with ID matching assumes pending actions have stable, user-visible identifiers — without these, users can't reference specific actions
- The parser is intentionally conservative: when in doubt, it returns `not-applicable` and lets the LLM handle it. False negatives (missed approval) are far less dangerous than false positives (accidental execution)

## Code Example

```javascript
// Full approval flow lifecycle

// 1. Agent proposes an action and queues it for approval
async function proposeAction(userId, action) {
  const pending = {
    id: generateId(),
    description: action.description,
    tool: action.tool,
    args: action.args,
    proposedAt: Date.now(),
    ttlMs: 24 * 60 * 60 * 1000, // expires after 24 hours
  };

  await savePendingAction(userId, pending);
  return `I'd like to ${action.description}. Shall I go ahead?`;
}

// 2. User responds naturally — parser handles it before the LLM
// "yes"                    -> approve all pending
// "go ahead"               -> approve all pending
// "approve #42"            -> approve specific action
// "approve all"            -> approve all pending
// "no"                     -> deny all pending
// "hold off"               -> deny all pending
// "yes but use staging"    -> qualified, routes to LLM
// "maybe"                  -> ambiguous, asks for clarification
// "what's the weather?"    -> not-applicable, normal processing

// 3. Approved actions execute immediately
async function executeApprovedActions(actionIds, userId) {
  const actions = await getPendingActionsByIds(userId, actionIds);

  for (const action of actions) {
    await executeTool(action.tool, action.args, userId);
    await removePendingAction(userId, action.id);
  }
}

// 4. Expired actions are cleaned up automatically
async function cleanExpiredActions(userId) {
  const pending = await getPendingActions(userId);
  const now = Date.now();

  for (const action of pending) {
    if (now - action.proposedAt > action.ttlMs) {
      await removePendingAction(userId, action.id);
    }
  }
}
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Agent Recovery and Escalation](./agent-recovery-and-escalation.md)
- [Message Processing Pipeline](./message-processing-pipeline.md)
