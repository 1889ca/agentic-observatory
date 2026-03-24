# Multi-Dispatch Strategy

> A single dispatcher selects from three execution strategies — synchronous, runner-based, and fire-and-forget — based on task metadata, while all strategies share the same lifecycle state machine.

## Problem

Not all tasks have the same execution requirements. Some need immediate results and ordered execution — a user-facing request that must complete before the next step begins. Others need persistent workers that pick up tasks from a queue without being explicitly invoked each time. Still others need to run in the background without blocking the dispatch cycle at all. Using a single execution model forces trade-offs: if everything is synchronous, background work blocks foreground work; if everything is async, you lose result tracking where it matters.

## Context

- A dispatcher that receives work from multiple sources: scheduled tasks, manual triggers, API requests, and agent-initiated work
- Tasks vary in urgency, result requirements, and whether a persistent worker process is available
- Worker availability is not guaranteed — some task types have dedicated runner processes, others do not
- A priority queue already orders work by weight; the dispatch strategy governs how the selected work actually executes
- All tasks share a common lifecycle state machine and DB persistence layer regardless of execution path

## Solution

### Three Dispatch Strategies

The dispatcher exposes three modules, each implementing the same task intake interface but with different execution behavior.

**`dispatch.js` — Synchronous dispatch**

Used for tasks that need immediate result tracking and sequential execution. The dispatcher `await`s completion before moving to the next item. Appropriate for user-facing requests or tasks where the result must be known before subsequent work can proceed.

```javascript
// lib/worker/dispatch.js (illustrative)
async function dispatchSync(task) {
  // Transition task to in_progress before execution begins
  await lifecycle.transition(task, 'in_progress', { strategy: 'sync' });

  try {
    const result = await executeWorker(task);
    await lifecycle.completeTask(task, result);
    return result;
  } catch (err) {
    await lifecycle.failTask(task, err);
    throw err;
  }
}
```

**`dispatch-runners.js` — Runner-based dispatch**

Used for persistent worker processes that monitor a queue and self-assign tasks. Rather than spawning a new process per task, the dispatcher posts a task to a known slot and a long-lived runner picks it up. This avoids process spawn overhead for high-frequency work types and gives workers control over their own pacing.

```javascript
// lib/worker/dispatch-runners.js (illustrative)
async function dispatchToRunner(task, runnerId) {
  // Persist task to queue slot; runner polls and claims it
  await db.tasks.insert({
    ...task,
    state: 'queued',
    assignedRunner: runnerId,
    strategy: 'runner',
    queuedAt: Date.now(),
  });

  // Runner process polls this slot and calls lifecycle.transition(task, 'in_progress') on claim
  audit.log('dispatch:runner_queued', { taskId: task.id, runnerId });
}
```

**`dispatch-async.js` — Async fire-and-forget dispatch**

Used for background tasks that don't need immediate results. The dispatcher spawns the worker and continues without waiting. Task state is persisted so results can be queried later, but nothing blocks on them. Suitable for maintenance work, ambient processing, and low-urgency agent-initiated tasks.

```javascript
// lib/worker/dispatch-async.js (illustrative)
function dispatchAsync(task) {
  // Transition to in_progress and spawn — do not await
  lifecycle.transition(task, 'in_progress', { strategy: 'async' }).then(() => {
    spawnWorker(task).catch(err => lifecycle.failTask(task, err));
  });

  audit.log('dispatch:async_spawned', { taskId: task.id });
  // Returns immediately; result is tracked via DB, not return value
}
```

### Work-Source Abstraction

Tasks enter the dispatcher through a work-source abstraction that normalizes different origins into a common task format. Sources include scheduled cron tasks, manual triggers from the API, incoming API requests from external systems, and agent-initiated work from satellites. Each source attaches metadata (urgency, expected result handling, preferred strategy hint) that the dispatcher uses for strategy selection.

```javascript
// lib/worker/identify-work.js (illustrative)
async function identifyWork() {
  const [scheduled, manual, apiRequests, agentWork] = await Promise.all([
    sources.scheduled.pending(),
    sources.manual.pending(),
    sources.api.pending(),
    sources.agent.pending(),
  ]);

  // Normalize all sources into the same task shape
  return [...scheduled, ...manual, ...apiRequests, ...agentWork].map(normalize);
}
```

### Strategy Selection

After the priority queue has ordered work by weight, the dispatcher inspects each task's metadata to select the appropriate execution strategy:

```javascript
// lib/worker/dispatcher.js (illustrative)
async function routeTask(task) {
  const runnerAvailable = await runners.hasAvailable(task.taskType);

  if (task.requiresResult || task.urgency === 'high') {
    // User is waiting or result feeds into next step
    return dispatchSync(task);
  }

  if (runnerAvailable) {
    // Persistent worker process is ready to pick up this task type
    return dispatchToRunner(task, runners.assign(task.taskType));
  }

  // Background work — spawn and move on
  return dispatchAsync(task);
}
```

### Shared Lifecycle and Persistence

All three strategies call into the same lifecycle module (`lib/task-lifecycle.js`) for state transitions, persistence, and event emission. The execution path is invisible to the lifecycle layer — a task that went through `dispatchAsync` has the same DB record structure and valid transitions as one that went through `dispatchSync`.

```javascript
// lib/task-lifecycle.js is strategy-agnostic
// All three dispatch paths call the same transition/complete/fail functions
await lifecycle.transition(task, 'in_progress', { strategy: task.meta.strategy });
await lifecycle.completeTask(task, result);
await lifecycle.failTask(task, error);
```

## Implications

- Adding a fourth strategy requires only a new module implementing the same intake interface — the dispatcher's routing logic is the only change point.
- Fire-and-forget dispatch reduces dispatch cycle latency but shifts result visibility to polling or event listeners on the DB; callers that need results must use sync dispatch explicitly.
- Runner-based dispatch introduces a dependency on runner availability — if a runner crashes and is not restarted, queued tasks accumulate without being claimed until the runner recovers.
- Strategy selection based on task metadata means metadata must be accurate at enqueue time; stale or incorrect urgency flags will cause misrouted work.
- Shared lifecycle state ensures consistent observability (dashboards, audits, alerts) across all three paths, but requires strict discipline — no strategy should update task state directly in the DB, always via lifecycle functions.
- The distinction between this pattern and the priority queue is intentional: the queue answers "what to do next," this pattern answers "how to do it."

## Code Example

```javascript
// Dispatcher selects strategy after priority queue has ranked work
async function dispatchCycle() {
  const candidates = sortByPriority(await identifyWork());
  const available = getAvailableWorkerCount();

  for (const task of candidates.slice(0, available)) {
    if (!canDispatch(task, runningRepos)) continue;

    trackRepo(task);

    // Strategy selection based on task metadata and runner availability
    const runnerAvailable = await runners.hasAvailable(task.taskType);

    if (task.requiresResult || task.urgency === 'high') {
      // Sync: await result before continuing dispatch loop iteration
      await dispatchSync(task).finally(() => untrackRepo(task));
    } else if (runnerAvailable) {
      // Runner: post to queue slot, persistent worker claims it
      await dispatchToRunner(task, runners.assign(task.taskType));
      untrackRepo(task);
    } else {
      // Async: spawn and move on
      dispatchAsync(task);
      task.promise.finally(() => untrackRepo(task));
    }

    audit.log('dispatch:routed', {
      taskId: task.id,
      strategy: task.meta.strategy,
      source: task.source,
      urgency: task.urgency,
    });

    recordDispatchCost(task);
  }
}

setInterval(dispatchCycle, DISPATCH_TICK_MS);
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
