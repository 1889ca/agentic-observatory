# Task Lifecycle and State Machine

> Document-based task state machine with states `pending/in_progress/in_review/changes_needed/done/failed/cancelled`, validated transitions, worker integration with phase tracking, and automated review/rework cycles.

## Problem

Tasks in an agent system go through multiple states: pending, in progress, in review, completed, failed, cancelled. Without a formal state machine, transitions happen ad-hoc — a task might jump from "pending" to "cancelled" without ever being worked, or get stuck in "in_progress" after a worker crash. Invalid transitions create inconsistent state and make debugging impossible.

## Context

- Tasks are stored as documents in a unified `documents` table with status in a JSONB `data` column
- Multiple actors can trigger transitions: the worker system, code review automation, and users
- Tasks flow through a coding -> review -> rework cycle that requires specific intermediate states
- The `completed` alias maps to `done` for backward compatibility

## Solution

### State Machine

Tasks follow a strict state machine with seven states. Notable: there is no `blocked` state, but there are `in_review` and `changes_needed` states for the code review cycle:

```javascript
// lib/document-tasks/constants.js
const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  CHANGES_NEEDED: 'changes_needed',
  DONE: 'done',
  COMPLETED: 'done',    // Backward compat alias
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const VALID_TRANSITIONS = {
  pending:         ['in_progress', 'done', 'cancelled'],
  in_progress:     ['in_review', 'done', 'failed', 'cancelled'],
  in_review:       ['done', 'changes_needed', 'failed', 'cancelled'],
  changes_needed:  ['in_progress', 'cancelled'],
  done:            ['pending'],    // Reopen
  failed:          ['pending'],    // Reopen
  cancelled:       ['pending'],    // Reopen
};
```

Key design decisions:
- `pending` can transition directly to `done` (for tasks completed immediately)
- `in_progress` goes to `in_review` (not directly to `done` in the review flow)
- `in_review` can result in `done` (approved), `changes_needed` (reviewer requests changes), or `failed`
- `changes_needed` can only go back to `in_progress` (rework) or be `cancelled`
- Terminal states (`done`, `failed`, `cancelled`) can all reopen to `pending`

### Status Alias Normalization

The `completed` alias is normalized to `done` throughout the system:

```javascript
function normalizeStatus(status) {
  if (status === 'completed') return 'done';
  return status;
}
```

### Transition Validation

Every transition attempt is validated against the transition map. Invalid transitions throw:

```javascript
// lib/document-tasks/transitions.js
function canTransition(from, to) {
  from = normalizeStatus(from);
  to = normalizeStatus(to);
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

async function transitionTask(taskId, newStatus, options = {}) {
  const doc = await documents.get(taskId);
  if (!doc) throw new Error(`Document ${taskId} not found`);

  const currentStatus = normalizeStatus(doc.data?.status || 'pending');
  newStatus = normalizeStatus(newStatus);

  if (!canTransition(currentStatus, newStatus)) {
    throw new Error(`Invalid transition: ${currentStatus} → ${newStatus} for task ${taskId}`);
  }

  const data = { ...doc.data, status: newStatus };

  // Set completed_at on terminal success
  if (newStatus === 'done') {
    data.completed_at = new Date().toISOString();
  } else if (currentStatus === 'done' || currentStatus === 'failed') {
    data.completed_at = null;  // Clear on reopen
  }

  // Track worker phase if provided
  if (options.phase) data.currentPhase = options.phase;

  // Append to workerHistory
  if (options.workerEntry) {
    const history = Array.isArray(data.workerHistory) ? [...data.workerHistory] : [];
    const entry = { ...options.workerEntry, updatedAt: new Date().toISOString() };
    const latest = history[history.length - 1];
    if (latest && latest.phase === entry.phase && !latest.completedAt) {
      history[history.length - 1] = { ...latest, ...entry };  // Update in-place
    } else {
      history.push(entry);  // New phase
    }
    data.workerHistory = history;
  }

  const changeSummary = options.summary || `Status: ${currentStatus} → ${newStatus}`;
  return await documents.update(taskId, data, { changedBy: 'system', changeSummary });
}
```

### Worker Phases

Tasks track worker execution phases in a `workerHistory` array within the document data. Phases map to the review cycle:

```javascript
const PHASE = {
  CODING: 'coding',
  REVIEW: 'review',
  REWORK: 'rework',
};
```

### Lifecycle Event Handling

The lifecycle module listens for worker task completion events and orchestrates the response, including PR creation, code review dispatch, and rework cycles:

```javascript
// lib/task-lifecycle.js
function init() {
  internalBus.on('task:complete', async (data) => {
    const { taskId, success, result, error } = data;
    const task = await workerTasks.get(taskId);

    if (success) {
      await handleTaskComplete(task, { prUrl: result?.prUrl, filesChanged: result?.filesChanged });

      // Trigger code review for PR-producing tasks
      if (prUrl && taskType !== 'code-review') {
        await reviewTrigger.maybeDispatchReview({ taskId, prUrl, description: task.description });
      }

      // Handle code-review completion
      if (taskType === 'code-review') {
        if (result?.autoMerged) {
          await transitionTask(sourceDocId, 'done', { summary: 'PR auto-merged' });
        }
        if (result?.verdict === 'REQUEST_CHANGES') {
          await transitionTask(sourceDocId, 'changes_needed', { summary: result.summary });
          await reviewTrigger.maybeDispatchRework({ prUrl, reviewSummary: result.summary });
        }
        if (result?.verdict === 'APPROVE') {
          await transitionTask(sourceDocId, 'done', { summary: 'Review approved' });
        }
      }
    } else {
      await handleTaskFailure(task, error, { attemptCount, canRetry });
    }
  });
}
```

### Completion and Failure Handling

On completion, the lifecycle module notifies the user. On failure, it either auto-retries (up to 3 attempts by resetting to pending) or escalates by prompting Riley to decide:

```javascript
async function handleTaskFailure(task, error, options = {}) {
  const { attemptCount = 0, canRetry = false } = options;

  if (canRetry && attemptCount < 3) {
    await workerTasks.resetToPending(task.task_id);
    await lifecycleMessenger.notification('warning',
      `Retrying task: ${task.description} (attempt ${attemptCount + 1})`
    );
    return { action: 'retrying' };
  }

  // Max retries reached — escalate to Riley
  await promptRileyOnFailure(task, error, { attemptCount });
  return { action: 'escalated' };
}
```

### The Review Cycle

The full coding -> review -> rework cycle uses the state machine:

```
pending → in_progress (worker starts coding)
       → in_review (PR created, review dispatched)
       → done (review approved or auto-merged)

       OR

       → changes_needed (reviewer requests changes)
       → in_progress (rework dispatched)
       → in_review (rework complete, re-review)
       → done (approved on second pass)
```

Rework has a cap — if the rework limit is reached, the PR is flagged for manual attention.

## Implications

- Seven states (not five) — `in_review` and `changes_needed` are first-class states that model the code review workflow, not ad-hoc status strings
- No `blocked` state exists — external dependencies are handled differently (tasks stay `in_progress` or are `cancelled`)
- The `completed` -> `done` alias ensures backward compatibility but means the canonical state is always `done`
- All terminal states (`done`, `failed`, `cancelled`) can reopen to `pending` — nothing is permanently terminal
- Worker history is tracked per-phase in a JSONB array, creating a full audit trail of coding -> review -> rework cycles
- The lifecycle module prompts Riley (the AI) on failure, creating a human-in-the-loop escalation path for tasks that can't auto-recover
- Document versioning (`changeSummary`) means every transition is recorded as a version, enabling time-travel debugging

## Code Example

```javascript
const { transitionTask, canTransition } = require('./lib/document-tasks/transitions');
const { TASK_STATUS, VALID_TRANSITIONS } = require('./lib/document-tasks/constants');

// Check if a transition is valid
canTransition('pending', 'in_progress');       // true
canTransition('pending', 'done');              // true (skip work)
canTransition('pending', 'in_review');         // false (must go through in_progress)
canTransition('in_review', 'changes_needed');  // true (reviewer requests changes)
canTransition('changes_needed', 'done');       // false (must go back to in_progress first)

// Transition with worker history tracking
await transitionTask(taskId, 'in_progress', {
  phase: 'coding',
  summary: 'Worker started coding task',
  workerEntry: { phase: 'coding', workerTaskId: 'wt_123', startedAt: new Date().toISOString() },
});

// Review cycle
await transitionTask(taskId, 'in_review', {
  phase: 'review',
  summary: 'PR created, review dispatched',
});

await transitionTask(taskId, 'changes_needed', {
  summary: 'Review requested changes: missing error handling',
});

await transitionTask(taskId, 'in_progress', {
  phase: 'rework',
  summary: 'Rework dispatched for review feedback',
});

await transitionTask(taskId, 'done', {
  summary: 'Review approved on second pass',
});
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
