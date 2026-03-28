# Implicit Approval Parsing

> Natural language parsing of simple approval and denial responses using exact `Set.has()` matching against normalized input, with context gating that only activates on a single pending action match.

## Problem

Autonomous agents frequently need human approval before executing consequential actions — deploying to production, sending an email, merging a PR. The typical implementation requires structured commands: `/approve 123`, `!confirm deploy`. But humans don't think in commands. They say "yeah go ahead", "do it", "no wait, hold off on that." Forcing users into rigid command syntax creates friction and breaks conversational flow. The agent should understand natural approval language the same way a human colleague would.

## Context

- An orchestrator with a pending action queue — tool calls awaiting human approval before execution
- Users communicating through conversational channels (chat, Telegram, web UI)
- Two parsing paths: explicit approval (`approve #123`) and implicit natural language (`yes`, `go ahead`)
- The implicit parser must avoid false positives — accidentally executing an action because the user said "yes" to something unrelated
- Implicit approval only applies when there is exactly one pending action for the session

## Solution

### Explicit Approval Parsing

The explicit parser handles structured `approve #ID` patterns using regex:

```javascript
// lib/message-processor/approval.js
function parseApprovalCommand(text) {
  const approvePattern = /\bapprove\s*#?(\d+)\b/i;
  const match = text.match(approvePattern);
  if (match) {
    return { matched: true, actionId: parseInt(match[1], 10) };
  }
  return { matched: false };
}
```

### Implicit Approval via Set.has()

The implicit parser uses exact `Set.has()` matching against normalized input — not regex, not substring matching. The input is trimmed, lowercased, and stripped of trailing punctuation before checking:

```javascript
function parseImplicitApprovalDecision(text) {
  if (!text) return { matched: false };
  const normalized = String(text)
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');

  const approve = new Set([
    'yes', 'yep', 'yeah', 'sure', 'ok', 'okay',
    'do it', 'go ahead', 'approve', 'approve it',
    'yes please', 'okay please', 'ok please',
    'go ahead please', 'do it please', 'sounds good',
  ]);

  const reject = new Set([
    'no', 'nope', 'nah', 'dont', "don't", 'do not',
    'stop', 'cancel', 'reject', 'reject it',
    'no thanks', 'no thank you',
  ]);

  if (approve.has(normalized)) return { matched: true, decision: 'approve' };
  if (reject.has(normalized)) return { matched: true, decision: 'reject' };
  return { matched: false };
}
```

Key design decisions:
- **Exact match, not substring** — "yes" matches but "yesterday" does not, because the entire normalized string must equal a set entry
- **Normalization strips punctuation** — "Yes!" becomes "yes", "Go ahead." becomes "go ahead"
- **Whitespace collapsed** — "go  ahead" becomes "go ahead" and matches
- **No ambiguous category** — messages either match exactly or fall through to the LLM

### Context-Gated Activation

The implicit parser is only invoked when there are pending approvals for the current session. If the user says "yes" in normal conversation with nothing pending, the message flows through to the LLM as usual. The single-match constraint adds further safety:

```javascript
// In the message processing pipeline
const pendingActions = await agentActions.getPendingToolCalls();

if (pendingActions.length === 1) {
  // Only auto-apply implicit approval when exactly ONE action is pending
  const decision = parseImplicitApprovalDecision(message.text);
  if (decision.matched) {
    if (decision.decision === 'approve') {
      return await executeApprovedAction(pendingActions[0].id, ctx, correlationId);
    } else {
      return await rejectAction(pendingActions[0].id);
    }
  }
}
```

When multiple actions are pending, implicit approval is not used — the user must use explicit `approve #ID` syntax to target specific actions.

### Approved Action Execution

Once approved, the action is executed through the tool system with timeout protection:

```javascript
async function executeApprovedAction(actionId, ctx, correlationId) {
  const action = await agentActions.getPendingToolCallById(actionId);
  if (!action) return { executed: false, error: `Action #${actionId} not found` };

  await agentActions.approveAction(actionId);

  const result = await agentActions.executeApprovedToolCall(
    actionId,
    async (toolName, toolArgs) => executeToolWithTimeout(toolName, toolArgs)
  );

  audit.log('approval:executed', {
    actionId, toolName: result.toolName, success: result.success,
  }, { correlationId });

  return { executed: true, toolName: result.toolName, result: result.result };
}
```

## Implications

- `Set.has()` matching is O(1) and has zero false-positive risk from substring matching — "yesterday" never triggers approval because it's not in the set
- The normalized-then-exact-match approach means only known phrases trigger approval — there's no fuzzy matching or similarity scoring
- Single-pending-action gating eliminates ambiguity about which action "yes" refers to — with multiple pending actions, the user must be explicit
- No ambiguous category exists — the parser returns `matched: false` for anything not in the sets, and the message falls through to normal LLM processing
- The approval and rejection sets are intentionally small and conservative — about 15 approval phrases and 12 rejection phrases
- Punctuation stripping (`"Yes!"` -> `"yes"`) handles common conversational patterns without expanding the match set
- The explicit `approve #ID` path works regardless of how many actions are pending and doesn't require normalization
- All approvals are audit-logged with correlation IDs for full traceability

## Code Example

```javascript
// Full approval flow lifecycle

// 1. Agent proposes a tool call that requires approval
// (autonomy gating queues it instead of executing)
// → Pending: { id: 42, toolName: 'send_email', args: { to: 'client@...' } }

// 2. User responds naturally
// "yes"         → Set.has('yes')        → approve action #42
// "go ahead"    → Set.has('go ahead')   → approve action #42
// "nope"        → Set.has('nope')       → reject action #42
// "sounds good" → Set.has('sounds good') → approve action #42
// "yesterday"   → not in set            → falls through to LLM
// "maybe"       → not in set            → falls through to LLM

// 3. With multiple pending actions, implicit matching is skipped
// User must use: "approve #42" or "approve #43"
const explicit = parseApprovalCommand('approve #42');
// { matched: true, actionId: 42 }

// 4. Approved action executes immediately via tool system
const result = await executeApprovedAction(42, ctx, correlationId);
// { executed: true, toolName: 'send_email', result: { success: true } }
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Message Processing Pipeline](./message-processing-pipeline.md)
