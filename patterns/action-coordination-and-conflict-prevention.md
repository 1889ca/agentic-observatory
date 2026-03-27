# Action Coordination and Conflict Prevention

> Buffer pending operations with batch approval, conflict checking before dispatch, and recent-action tracking to prevent duplicate or contradictory work.

## Problem

An autonomous agent that can take multiple actions — sending messages, creating tasks, modifying data — can easily step on itself. Two concurrent pipeline stages might both try to send a follow-up message. A scheduled job might create a task that a manual request already created seconds ago. Without coordination, the agent produces duplicate messages, conflicting data modifications, and confused users who receive the same notification twice.

## Context

- An AI agent with multiple execution paths: interactive chat, background workers, scheduled tasks, autonomous cycles
- Actions have side effects visible to users (messages sent, tasks created, integrations triggered)
- Some actions are idempotent (reading data) but many are not (sending a Telegram message)
- The agent processes requests concurrently — race conditions are not theoretical
- Users expect the agent to act coherently, not like multiple uncoordinated bots

## Solution

An action coordination layer sits between intent and execution. All actions pass through a buffer that checks for conflicts against recent actions and pending operations before dispatch. Batch approval groups related actions for user review when autonomy rules require it.

### Action Buffer

Pending actions are buffered with metadata for conflict detection:

```javascript
// lib/orchestrator/coordination.js — illustrative
const pendingActions = [];
const recentActions = [];  // Sliding window of last N executed actions
const RECENT_WINDOW = 300_000; // 5 minutes

function bufferAction(action) {
  const conflicts = checkConflicts(action);

  if (conflicts.length > 0) {
    logger.warn('Action conflicts detected', {
      action: action.type,
      conflicts: conflicts.map(c => c.reason),
    });
    return { status: 'blocked', conflicts };
  }

  pendingActions.push({
    ...action,
    bufferedAt: Date.now(),
    status: 'pending',
  });

  return { status: 'buffered' };
}
```

### Conflict Detection

The conflict checker compares incoming actions against both pending and recently executed actions using type-specific rules:

```javascript
function checkConflicts(action) {
  const conflicts = [];
  const candidates = [...pendingActions, ...getRecentActions()];

  for (const existing of candidates) {
    // Same target, same action type = duplicate
    if (existing.type === action.type && existing.target === action.target) {
      conflicts.push({
        existing,
        reason: 'duplicate',
        message: `${action.type} on ${action.target} already ${existing.status}`,
      });
      continue;
    }

    // Type-specific conflict rules
    if (CONFLICT_RULES[action.type]?.(action, existing)) {
      conflicts.push({
        existing,
        reason: 'logical-conflict',
        message: CONFLICT_RULES[action.type].message(action, existing),
      });
    }
  }

  return conflicts;
}

const CONFLICT_RULES = {
  'send-message': (action, existing) => {
    // Don't send two messages to the same recipient within 30s
    return existing.type === 'send-message'
      && existing.target === action.target
      && (Date.now() - existing.executedAt) < 30_000;
  },
  'create-task': (action, existing) => {
    // Don't create tasks with identical titles
    return existing.type === 'create-task'
      && existing.payload?.title === action.payload?.title;
  },
};
```

### Recent Action Tracking

Executed actions are tracked in a sliding window for conflict detection and audit:

```javascript
// lib/orchestrator/action-log.js — illustrative
function recordExecution(action, result) {
  recentActions.push({
    ...action,
    executedAt: Date.now(),
    result: result.success ? 'success' : 'failure',
  });

  // Prune old entries
  const cutoff = Date.now() - RECENT_WINDOW;
  while (recentActions.length > 0 && recentActions[0].executedAt < cutoff) {
    recentActions.shift();
  }
}

function getRecentActions(filter = {}) {
  return recentActions.filter(a => {
    if (filter.type && a.type !== filter.type) return false;
    if (filter.target && a.target !== filter.target) return false;
    return true;
  });
}
```

### Batch Approval

When multiple related actions are pending and autonomy rules require user approval, they are grouped for batch review:

```javascript
function groupForApproval(pending) {
  const groups = {};

  for (const action of pending) {
    const key = action.approvalGroup ?? action.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(action);
  }

  return Object.entries(groups).map(([group, actions]) => ({
    group,
    count: actions.length,
    actions: actions.map(a => ({
      type: a.type,
      target: a.target,
      summary: a.summary,
    })),
  }));
}

// User approves or rejects a batch
async function approveBatch(groupId, approved) {
  const actions = pendingActions.filter(a =>
    (a.approvalGroup ?? a.type) === groupId
  );

  for (const action of actions) {
    if (approved) {
      await dispatch(action);
    } else {
      action.status = 'rejected';
    }
  }
}
```

## Implications

- The buffer adds latency between intent and execution — acceptable for most actions, but immediate actions (like user-requested sends) may need a fast path
- Conflict detection is rule-based, not ML-based — new action types require new conflict rules
- Recent action window (5 minutes) is a tuning parameter: too short misses slow-developing conflicts, too long blocks legitimate retries
- Batch approval reduces notification noise but requires UI support for grouped action review
- The coordination layer is in-memory — doesn't survive restarts. Persistent buffering would add durability at the cost of complexity
- False positives (blocking legitimate similar actions) are less harmful than false negatives (allowing duplicates through)

## Code Example

```javascript
// Worker tries to send a follow-up message
const result = bufferAction({
  type: 'send-message',
  target: 'user:alice',
  payload: { text: 'Following up on your request' },
  source: 'scheduled-task',
});
// → { status: 'blocked', conflicts: [{ reason: 'duplicate', message: 'send-message on user:alice already executed 15s ago' }] }

// Two tasks created from different sources — conflict caught
bufferAction({ type: 'create-task', payload: { title: 'Review PR #42' }, source: 'chat' });
bufferAction({ type: 'create-task', payload: { title: 'Review PR #42' }, source: 'worker' });
// Second one blocked as duplicate
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Undo and Revert System](./undo-and-revert-system.md)
