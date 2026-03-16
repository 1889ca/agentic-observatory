# Worker Dispatcher and Priority Queue

> Weighted event prioritization with resource-level locking and budget tracking for dispatching work through the cognitive processor without conflicts.

## Problem

An orchestrator receives events from many sources — user messages, task results, webhooks, scheduled jobs, ambient activity. Each event type has different urgency, but a naive FIFO queue means a flood of low-priority ambient events can delay processing a user's urgent message. Additionally, two dispatched workers operating on the same resource simultaneously can create conflicts or corrupt state.

## Context

- Multiple event types with different urgency levels feeding a shared processing queue
- A cognitive processor that evaluates and dispatches events to appropriate handlers
- Risk of concurrent operations on the same resource from different workers
- Need for budget tracking to prevent runaway cost
- Some work items can safely run in parallel (isolated tasks)

## Solution

### Weighted Event Prioritization

Each event type is assigned a static weight. When the dispatcher ticks, it evaluates all pending items and processes highest-weight items first:

```javascript
// cognitive/processor.js
const SOURCE_WEIGHTS = {
  message:      90,  // Highest: human is waiting for a response
  task_result:  80,  // Completed work needs processing before new dispatch
  webhook:      70,  // External event, time-sensitive
  scheduled:    50,  // Important but expected, can wait briefly
  ambient:      30,  // Lowest: background activity, observations
};

function getWeight(item) {
  return SOURCE_WEIGHTS[item.source] || 0;
}

function sortByPriority(items) {
  return items.sort((a, b) => getWeight(b) - getWeight(a));
}
```

### Resource-Level Locking

Before dispatching a worker to a resource, the dispatcher checks whether another worker is already operating on that resource. This prevents concurrent operations that would cause conflicts:

```javascript
// worker/repo-lock.js
const activeResources = new Map(); // resource → { workerId, startedAt }

function canDispatch(item) {
  const resource = item.resource || item.workdir;
  if (!resource) return true; // No resource context — allow

  if (activeResources.has(resource)) {
    // Exception: isolated tasks can run in parallel
    if (item.isolation === 'isolated') return true;

    audit.log('dispatcher:skip_item', {
      reason: 'resource_in_use',
      resource,
      source: item.source,
    });
    return false;
  }

  return true;
}

function lockResource(resource, workerId) {
  activeResources.set(resource, { workerId, startedAt: Date.now() });
}

function unlockResource(resource) {
  activeResources.delete(resource);
}
```

### Dispatch Loop

The dispatcher runs on a tick interval, evaluating pending work and dispatching to available workers:

```javascript
async function tick() {
  const pending = await getPendingItems();
  const sorted = sortByPriority(pending);
  const availableWorkers = getAvailableWorkerCount();

  let dispatched = 0;

  for (const item of sorted) {
    if (dispatched >= availableWorkers) break;
    if (!canDispatch(item)) continue;

    const resource = item.resource || item.workdir;
    if (resource) lockResource(resource, item.id);

    await dispatchToWorker(item);
    dispatched++;

    // Track budget
    recordDispatchCost(item);
  }
}
```

### Budget Tracking

Each dispatch records estimated cost to prevent runaway spending:

```javascript
function recordDispatchCost(item) {
  const modelCost = MODEL_COSTS[item.model || 'sonnet'];
  budget.record({
    source: item.source,
    model: item.model,
    estimatedCost: modelCost,
    timestamp: Date.now(),
  });

  // Alert if daily budget threshold exceeded
  if (budget.dailyTotal() > DAILY_BUDGET_LIMIT) {
    logger.warn({ total: budget.dailyTotal() }, 'Daily budget threshold exceeded');
  }
}
```

### Max Parallel Workers

A global cap prevents overloading the machine:

```javascript
const MAX_PARALLEL_WORKERS = parseInt(process.env.MAX_WORKERS || '4');

function getAvailableWorkerCount() {
  const active = getActiveWorkerCount();
  return Math.max(0, MAX_PARALLEL_WORKERS - active);
}
```

### Audit Logging

Every dispatch decision is logged for post-mortem analysis:

```javascript
audit.log('dispatcher:dispatch', {
  itemId: item.id,
  source: item.source,
  weight: getWeight(item),
  resource: item.resource,
  model: item.model,
  queueDepth: pending.length,
});
```

## Implications

- Static weights are simple but inflexible — a user message always beats a webhook, even if the webhook is critical and the message is trivial. Dynamic weight adjustment could address this but adds complexity.
- Resource-level locking is coarse — two workers could safely operate on different parts of the same resource, but the lock prevents it. The isolation exception handles the most common safe-parallel case.
- Budget tracking is advisory (warns but doesn't stop) — hard budget enforcement would require a policy decision about which events to drop.
- The tick interval creates a maximum latency of one tick between an event arriving and dispatch. Sub-second dispatch requires a tighter interval at the cost of more CPU.
- Audit logging enables replay and diagnosis but generates volume — needs rotation or aggregation.
- Worker count caps prevent overload but can create backlogs during high-demand periods.

## Code Example

```javascript
// Complete dispatch cycle with priority, locking, and budget
async function dispatchCycle() {
  const pending = sortByPriority(await getPendingItems());
  const available = getAvailableWorkerCount();

  for (const item of pending.slice(0, available)) {
    const resource = item.resource || item.workdir;

    // Skip if resource is busy (unless isolated)
    if (resource && activeResources.has(resource) && item.isolation !== 'isolated') {
      continue;
    }

    // Lock resource and dispatch
    if (resource) lockResource(resource, item.id);

    audit.log('dispatcher:dispatch', {
      source: item.source,
      weight: getWeight(item),
      resource,
    });

    dispatchToWorker(item).finally(() => {
      if (resource) unlockResource(resource);
    });

    recordDispatchCost(item);
  }
}

// Run on interval
setInterval(dispatchCycle, DISPATCH_TICK_MS);
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
