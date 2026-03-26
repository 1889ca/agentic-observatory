# Worker Dispatcher and Priority Queue

> Worker-availability-based dispatch where tasks are routed to idle workers based on capacity, with parallel worker limits and audit logging.

## Problem

An orchestrator receives events from many sources — user messages, task results, webhooks, scheduled jobs, ambient activity. These events need to be dispatched to workers for processing, but workers are a limited resource. Without awareness of which workers are available and how many can run concurrently, the dispatcher either overloads the system or leaves capacity on the table while tasks wait.

## Context

- Multiple event types feeding a shared processing pipeline
- A pool of workers with a configurable concurrency limit
- Workers have availability states — idle workers can accept tasks, busy workers cannot
- Need for audit logging to track dispatch decisions
- Budget tracking to monitor operational cost

## Solution

### Worker Availability Model

The dispatcher tracks active workers against a configurable maximum. Dispatch decisions are driven by whether idle capacity exists:

```javascript
// worker/dispatcher.js
const MAX_PARALLEL_WORKERS = parseInt(process.env.MAX_PARALLEL_WORKERS) || 3;

function getAvailableWorkerCount() {
  const active = getActiveWorkerCount();
  return Math.max(0, MAX_PARALLEL_WORKERS - active);
}
```

### Dispatch Loop

The dispatcher collects pending work via `identifyWork()`, then dispatches tasks to available workers until capacity is exhausted:

```javascript
async function dispatch() {
  const candidates = await identifyWork();  // Collect pending tasks
  const available = getAvailableWorkerCount();

  let dispatched = 0;

  for (const item of candidates) {
    if (dispatched >= available) break;

    await dispatchToWorker(item);
    dispatched++;

    recordDispatchCost(item);
  }
}
```

The key constraint is worker availability — when all worker slots are occupied, remaining tasks wait for the next dispatch cycle regardless of urgency.

### Budget Tracking

Each dispatch records estimated cost to monitor spending:

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

### Audit Logging

Every dispatch decision is logged for post-mortem analysis:

```javascript
audit.log('dispatcher:dispatch', {
  itemId: item.id,
  source: item.source,
  resource: item.resource,
  model: item.model,
  queueDepth: pending.length,
});
```

### Periodic Dispatch Cycle

The dispatcher runs on a tick interval, checking for pending work and available workers each cycle:

```javascript
async function dispatchCycle() {
  const candidates = await identifyWork();
  const available = getAvailableWorkerCount();

  for (const item of candidates.slice(0, available)) {
    audit.log('dispatcher:dispatch', {
      source: item.source,
      resource: item.resource,
    });

    dispatchToWorker(item).finally(() => {
      // Worker slot freed when task completes
    });

    recordDispatchCost(item);
  }
}

// Run on interval
setInterval(dispatchCycle, DISPATCH_TICK_MS);
```

## Implications

- Worker availability is the primary dispatch constraint — tasks are dispatched when workers are free, not based on task priority weights
- The tick interval creates a maximum latency of one tick between an event arriving and dispatch. Sub-second dispatch requires a tighter interval at the cost of more CPU
- Budget tracking is advisory (warns but doesn't stop) — hard budget enforcement would require a policy decision about which events to drop
- Worker count caps prevent overload but can create backlogs during high-demand periods
- Audit logging enables replay and diagnosis but generates volume — needs rotation or aggregation
- Adding worker capacity is a configuration change (increase `MAX_PARALLEL_WORKERS`), not a code change

## Code Example

```javascript
// Complete dispatch cycle driven by worker availability
async function dispatchCycle() {
  const candidates = await identifyWork();
  const available = getAvailableWorkerCount();

  if (available === 0) {
    audit.log('dispatcher:skip_cycle', { reason: 'no_available_workers' });
    return;
  }

  let dispatched = 0;
  for (const item of candidates) {
    if (dispatched >= available) break;

    audit.log('dispatcher:dispatch', {
      source: item.source,
      resource: item.resource,
      workersAvailable: available - dispatched,
    });

    dispatchToWorker(item).finally(() => {
      // Slot freed — next cycle can dispatch more
    });

    recordDispatchCost(item);
    dispatched++;
  }
}

// Run on interval
setInterval(dispatchCycle, DISPATCH_TICK_MS);
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
