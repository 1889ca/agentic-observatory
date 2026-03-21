# Task Lifecycle and State Machine

> End-to-end task state machine with defined transitions (todo → in_progress → done/blocked/cancelled), completion/failure handling, and auto-retry for transient failures.

## Problem

Tasks in an agent system go through multiple states: queued, in progress, completed, failed, blocked, cancelled. Without a formal state machine, transitions happen ad-hoc — a task might jump from "todo" to "cancelled" without ever being worked, or get stuck in "in_progress" after a worker crash. Invalid transitions create inconsistent state and make debugging impossible.

## Context

Any system where tasks flow through multiple states and multiple actors (agents, workers, users) can trigger transitions. Especially important when tasks can fail and need retry logic.

## Solution

### State Machine

Tasks follow a strict state machine with these states and transitions:
- `todo` → `in_progress` (claimed by a worker)
- `in_progress` → `done` (completed successfully)
- `in_progress` → `failed` (execution error)
- `in_progress` → `blocked` (waiting on external dependency)
- `in_progress` → `cancelled` (user or system cancellation)
- `failed` → `todo` (auto-retry for transient failures)
- `blocked` → `todo` (dependency resolved)

Invalid transitions are rejected — you can't go from `todo` directly to `done`.

### Transition Validation (transitions.js)

A transitions map defines valid state changes. Every transition attempt is validated against this map before executing:

```javascript
// lib/document-tasks/transitions.js
const VALID_TRANSITIONS = {
  todo:        ['in_progress'],
  in_progress: ['done', 'failed', 'blocked', 'cancelled'],
  failed:      ['todo'],
  blocked:     ['todo'],
  done:        [],
  cancelled:   [],
};

function validateTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }
}

function transition(task, newState, metadata = {}) {
  validateTransition(task.state, newState);

  const previousState = task.state;
  task.state = newState;
  task.updatedAt = Date.now();
  task.history.push({ from: previousState, to: newState, at: task.updatedAt, ...metadata });

  return task;
}
```

### Completion/Failure Handling (task-lifecycle.js)

On completion, failure, or block — the lifecycle module classifies the outcome and applies the appropriate transition:

```javascript
// lib/task-lifecycle.js
async function completeTask(task, result) {
  transition(task, 'done', { result: summarize(result) });
  await persist(task);
  events.emit('task:done', { taskId: task.id, result });
}

async function failTask(task, error) {
  const isTransient = classifyError(error) === 'transient';

  if (isTransient && task.attempts < task.maxRetries) {
    // Transient failure — schedule retry
    transition(task, 'failed', { error: error.message, transient: true });
    await scheduleRetry(task);
  } else {
    // Permanent failure — stays failed
    transition(task, 'failed', { error: error.message, transient: false });
  }

  await persist(task);
  events.emit('task:failed', { taskId: task.id, error, transient: isTransient });
}

async function blockTask(task, reason) {
  transition(task, 'blocked', { reason });
  await persist(task);
  events.emit('task:blocked', { taskId: task.id, reason });
}
```

### Error Classification

Errors are classified to determine retry eligibility:

```javascript
const TRANSIENT_PATTERNS = [
  /timeout/i,
  /rate.?limit/i,
  /ECONNRESET/,
  /503/,
  /429/,
];

function classifyError(error) {
  const msg = error.message || String(error);
  return TRANSIENT_PATTERNS.some(p => p.test(msg)) ? 'transient' : 'permanent';
}
```

### Auto-Retry

Transient failures automatically transition back to `todo` with exponential backoff. Max retry count is configurable per task type:

```javascript
async function scheduleRetry(task) {
  task.attempts += 1;
  const delayMs = Math.min(
    BASE_RETRY_DELAY * Math.pow(2, task.attempts - 1),
    MAX_RETRY_DELAY,
  );

  // Transition back to todo after delay
  setTimeout(async () => {
    transition(task, 'todo', { retryAttempt: task.attempts });
    await persist(task);
    events.emit('task:retrying', { taskId: task.id, attempt: task.attempts });
  }, delayMs);
}
```

## Implications

- Strict transition validation prevents impossible states but requires all callers to use the transition API (no direct DB updates)
- Auto-retry prevents transient failures from permanently blocking work, but needs a max retry cap to avoid infinite loops
- The `blocked` state requires external resolution — someone/something must unblock it
- State machine events enable monitoring dashboards and alerting on stuck tasks
- Attempt tracking provides visibility into flaky tasks that repeatedly fail and retry

## Code Example

```javascript
// Full lifecycle: creation → claim → failure → retry → completion
const task = createTask({
  type: 'solve_issue',
  payload: { repo: 'acme/app', issue: 42 },
  maxRetries: 3,
});
// task.state = 'todo', task.attempts = 0

// Worker claims the task
transition(task, 'in_progress', { worker: 'satellite-7' });

// Worker hits a rate limit (transient failure)
await failTask(task, new Error('429 Too Many Requests'));
// task.state = 'failed', task.attempts = 1
// After backoff delay: task.state = 'todo' (auto-retry)

// Worker claims again on next dispatch cycle
transition(task, 'in_progress', { worker: 'satellite-7' });

// This time it succeeds
await completeTask(task, { pr: 'acme/app#123' });
// task.state = 'done'

// Attempting an invalid transition throws
transition(task, 'in_progress');
// Error: Invalid transition: done → in_progress
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
