# Orchestrator-Worker Communication

> Worker-type-based task routing where the orchestrator matches tasks to workers by type and availability, dispatching work to the first suitable idle worker.

## Problem

An orchestrator needs to dispatch heterogeneous work (code generation, issue solving, maintenance tasks, API-triggered jobs) to AI agent workers. Different tasks require different worker capabilities, and workers may be busy or unavailable. Without a routing layer that understands worker types and their current availability, the system either dispatches to the wrong worker type (causing failures) or dispatches to busy workers (creating queues where none are needed while idle workers sit unused).

## Context

- A central orchestrator dispatching work to Claude Code CLI processes
- Work arrives from multiple sources: scheduled cron tasks, manual operator triggers, agent-initiated sub-tasks, and inbound API requests
- Workers are typed — different worker types handle different categories of work
- Workers have availability states: idle workers can accept new tasks, busy workers cannot
- The dispatcher must match task requirements to the correct worker type and only dispatch to available workers

## Solution

### Architecture Overview

Work arrives at the dispatcher, which inspects the task to determine the required worker type. It then queries available workers of that type and routes the task to an idle one. If no workers of the required type are available, the task waits until one becomes free.

```
Work Sources
  scheduled tasks
  manual triggers       -->  dispatch.js (router)
  agent-initiated work         |
  API requests           worker type check
                               |
                        availability check
                               |
                        route to idle worker
```

### dispatch.js — Worker-Type Routing

The dispatcher is the single entry point for task execution. It determines the required worker type from task metadata and finds an available worker of that type:

```javascript
// lib/worker/dispatch.js (illustrative)
async function dispatch(task) {
  await db.query(
    `UPDATE tasks SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`,
    [task.id]
  );

  const workerType = resolveWorkerType(task);
  const worker = await findAvailableWorker(workerType);

  if (!worker) {
    // No available worker of the right type — task stays queued
    await db.query(
      `UPDATE tasks SET status = 'queued' WHERE id = $1`,
      [task.id]
    );
    return null;
  }

  return assignTaskToWorker(worker, task);
}

function resolveWorkerType(task) {
  // Task metadata or type determines which worker category handles it
  return task.workerType || task.type || 'default';
}
```

### Worker Availability Tracking

Workers register their type and report availability. The dispatcher queries this state when routing:

```javascript
// lib/worker/availability.js (illustrative)
const workers = new Map(); // workerId -> { type, status, currentTask }

function registerWorker(workerId, type) {
  workers.set(workerId, { type, status: 'idle', currentTask: null });
}

function findAvailableWorker(workerType) {
  for (const [id, worker] of workers) {
    if (worker.type === workerType && worker.status === 'idle') {
      return { id, ...worker };
    }
  }
  return null;
}

function markBusy(workerId, taskId) {
  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'busy';
    worker.currentTask = taskId;
  }
}

function markIdle(workerId) {
  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'idle';
    worker.currentTask = null;
  }
}
```

### Task Assignment

Once a suitable idle worker is found, the task is assigned and the worker is marked busy:

```javascript
// lib/worker/dispatch.js (continued)
async function assignTaskToWorker(worker, task) {
  markBusy(worker.id, task.id);

  try {
    const result = await executeOnWorker(worker, task);
    await db.query(
      `UPDATE tasks SET status = 'completed', result = $1, completed_at = NOW() WHERE id = $2`,
      [JSON.stringify(result), task.id]
    );
    return result;
  } catch (err) {
    await db.query(
      `UPDATE tasks SET status = 'failed', error = $1 WHERE id = $2`,
      [err.message, task.id]
    );
    throw err;
  } finally {
    markIdle(worker.id);
  }
}
```

### Dispatch Loop

The dispatch loop periodically checks for queued tasks and attempts to route them:

```javascript
async function drainQueue() {
  const tasks = await db.query(
    `SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC`
  );

  for (const task of tasks.rows) {
    const workerType = resolveWorkerType(task);
    const worker = findAvailableWorker(workerType);
    if (worker) {
      await dispatch(task);
    }
  }
}
```

## Implications

- Worker-type routing ensures tasks reach workers with the right capabilities — a code-generation task goes to a coding worker, not a triage worker
- Availability checking prevents overloading busy workers while idle workers of the same type exist
- If all workers of a required type are busy, tasks queue naturally without blocking other worker types
- Adding a new worker type is a configuration change — register workers with the new type and tasks that resolve to it will route automatically
- DB-persisted task state survives orchestrator restarts — queued tasks can be re-dispatched on startup
- The simplicity of type + availability routing avoids the complexity of strategy-based dispatch while covering the common case well

## Code Example

```javascript
// End-to-end: task arrives, dispatcher routes by type and availability

// --- A coding task arrives ---
const task = await createTask({
  id: 'task-42',
  type: 'solve-issue',
  workerType: 'coding',
  prompt: 'Fix the null reference in billing-api/invoices.js',
});

// --- Dispatcher resolves worker type: 'coding' ---
// Checks availability: worker-3 (type: coding, status: idle) found.
// Assigns task-42 to worker-3. Marks worker-3 as busy.

// --- Meanwhile, a triage task arrives ---
const triageTask = await createTask({
  id: 'task-43',
  type: 'triage',
  workerType: 'triage',
  prompt: 'Review new GitHub issues for billing-api.',
});

// --- Dispatcher resolves worker type: 'triage' ---
// worker-1 (type: triage, status: idle) found.
// Assigns task-43 to worker-1. Different worker type, no conflict.

// --- Worker-3 finishes task-42, marked idle ---
// Next drain cycle can assign new coding tasks to worker-3.
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
