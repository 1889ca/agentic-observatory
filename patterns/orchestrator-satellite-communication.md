# Orchestrator-Worker Communication

> Multi-strategy task dispatch where work sources feed a priority queue and a central dispatcher selects between synchronous runner-based, asynchronous fire-and-forget, or direct execution strategies based on task type and requirements.

## Problem

An orchestrator needs to dispatch heterogeneous work (code generation, issue solving, maintenance tasks, API-triggered jobs) to AI agent workers, but no single dispatch strategy fits all task types. Long-running tasks need persistent runners with lifecycle tracking. Background cleanup jobs should not block the dispatch loop. Urgent tasks need to jump the queue. Without a layered dispatch architecture, the system either serializes everything through one path (creating bottlenecks) or spreads dispatch logic across unrelated modules (creating chaos).

## Context

- A central orchestrator dispatching work to Claude Code CLI processes
- Work arrives from multiple sources: scheduled cron tasks, manual operator triggers, agent-initiated sub-tasks, and inbound API requests
- Tasks vary in execution profile: some are fast and fire-and-forget, others are long-running and need process lifecycle management
- A priority queue governs ordering so urgent work is not delayed by a backlog of routine maintenance
- The dispatcher must select the right execution strategy per task without callers needing to know which strategy was chosen

## Solution

### Architecture Overview

Work flows from sources into a priority queue. The dispatcher (`dispatch.js`) evaluates each task and routes it to one of three strategies: runner-based dispatch for persistent workers, async dispatch for background tasks, or direct dispatch for simple one-shot execution. The dispatcher owns the routing decision — callers enqueue work and receive a task ID; they do not specify which dispatch strategy to use.

```
Work Sources
  scheduled tasks
  manual triggers       -->  Priority Queue  -->  dispatch.js (router)
  agent-initiated work                             |         |         |
  API requests                            runners  async   direct
                                            |         |         |
                                         persistent  fire-and  one-shot
                                         workers    forget    CC spawn
```

### dispatch.js — Main Dispatcher

The main dispatcher is the single entry point for all task execution. It reads from the priority queue, inspects task metadata, and delegates to the appropriate strategy module:

```javascript
// lib/worker/dispatch.js (illustrative)
async function dispatch(task) {
  await db.query(
    `UPDATE tasks SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`,
    [task.id]
  );

  if (task.type === 'background' || task.flags?.async) {
    return dispatchAsync(task);      // fire-and-forget path
  }

  if (task.type === 'long-running' || task.requiresPersistentRunner) {
    return dispatchRunner(task);     // persistent runner path
  }

  return dispatchDirect(task);       // one-shot CC spawn path
}

// Priority queue drain loop
async function drainQueue() {
  while (activeWorkers.size < maxConcurrency) {
    const task = priorityQueue.dequeue();
    if (!task) break;
    await dispatch(task);
  }
}
```

### dispatch-runners.js — Persistent Worker Processes

Runner-based dispatch manages long-lived worker processes that persist between tasks. Rather than spawning a new process per task, a runner process is acquired from the pool (or started if none are available) and assigned the task. This avoids process startup overhead for high-frequency work:

```javascript
// lib/worker/dispatch-runners.js (illustrative)
const runnerPool = new Map(); // runnerId -> { process, status, currentTask }

async function dispatchRunner(task) {
  const runner = await acquireRunner(task.project);

  runner.status = 'busy';
  runner.currentTask = task.id;

  // Send task to the persistent runner process via IPC
  runner.process.send({ type: 'task', payload: task });

  runner.process.once('message', (msg) => {
    if (msg.type === 'task:complete') {
      handleRunnerComplete(runner, task, msg.result);
    }
  });
}

async function acquireRunner(project) {
  const idle = [...runnerPool.values()].find(
    (r) => r.status === 'idle' && r.project === project
  );
  return idle ?? await spawnRunner(project);
}
```

### dispatch-async.js — Fire-and-Forget Background Tasks

Async dispatch handles tasks that should not occupy a concurrency slot or block the dispatch loop. The task is handed off to a background execution context and the dispatcher moves on immediately. Results are written directly to the DB when the background task completes:

```javascript
// lib/worker/dispatch-async.js (illustrative)
async function dispatchAsync(task) {
  // Mark as dispatched but do not occupy a concurrency slot
  setImmediate(async () => {
    try {
      const result = await runTaskInBackground(task);
      await db.query(
        `UPDATE tasks SET status = 'completed', result = $1, completed_at = NOW() WHERE id = $2`,
        [JSON.stringify(result), task.id]
      );
    } catch (err) {
      await db.query(
        `UPDATE tasks SET status = 'failed', error = $1 WHERE id = $2`,
        [err.message, task.id]
      );
    }
  });
  // Returns immediately — caller is not blocked
}
```

### Work Sources and Priority Queue

All entry points funnel into the same priority queue before dispatch. The queue enforces ordering but does not care about origin:

```javascript
// lib/worker/work-sources.js (illustrative)

// Scheduled task (cron)
scheduler.on('tick', (task) => priorityQueue.enqueue(task, task.priority));

// Manual operator trigger via CLI or admin API
app.post('/api/tasks/:id/run', async (req, res) => {
  const task = await db.findTask(req.params.id);
  priorityQueue.enqueue(task, 'high');  // manual triggers get elevated priority
  res.json({ queued: true });
});

// Agent-initiated sub-task (from a running CC worker)
ipc.on('spawn-subtask', (payload) => {
  priorityQueue.enqueue(payload.task, payload.priority ?? 'normal');
});
```

## Implications

- The dispatcher (`dispatch.js`) is the only module that decides which strategy to use — callers enqueue work and are shielded from dispatch implementation details
- Adding a new dispatch strategy is a localized change: add the strategy module and one routing branch in `dispatch.js`
- Runner-based dispatch reduces process startup overhead for frequent short tasks but introduces pool management complexity (runner health, stuck runners, pool sizing)
- Async dispatch must write its own DB completion records since the main dispatch loop has already moved on — failure to write these leaves tasks in a perpetual `dispatched` state
- The priority queue is the single choke point for observability: queue depth, lane distribution, and wait times are all measurable from one place
- DB-persisted task state survives orchestrator restarts — in-flight tasks can be detected on startup and re-queued or marked failed
- Work source diversity (scheduled, manual, agent, API) is a strength for flexibility but requires discipline to ensure all sources respect the priority queue rather than bypassing it

## Code Example

```javascript
// End-to-end: work source enqueues, dispatcher routes, strategy executes

// --- API request arrives for a background cleanup task ---
app.post('/api/cleanup', async (req, res) => {
  const task = await createTask({
    id: 'task-99',
    type: 'background',
    prompt: 'Delete stale worktrees older than 48h.',
    flags: { async: true },
    priority: 'low',
  });

  priorityQueue.enqueue(task, 'low');
  res.json({ taskId: task.id });
  // Returns immediately to the API caller
});

// --- Priority queue: [task-97 (high), task-99 (low)] ---
// Dispatcher drains high-priority work first.

// --- dispatch.js sees task-99 has flags.async = true ---
// Routes to dispatchAsync(task-99).
// dispatchAsync fires setImmediate and returns — concurrency slot not consumed.

// --- Background execution runs, cleanup finishes ---
// DB updated: status = 'completed', completed_at = NOW()

// --- Meanwhile, task-97 (long-running code generation) ---
// dispatch.js sees requiresPersistentRunner = true.
// Routes to dispatchRunner(task-97).
// dispatchRunner acquires or spawns a runner for the target project.
// Task is sent via IPC; runner process handles it and reports back.
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
