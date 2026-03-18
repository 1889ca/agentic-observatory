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
// worker/dispatcher.js
const SOURCE_WEIGHTS = {
  user_request:        90,  // Highest: human is waiting for a response
  retry_failed:        80,  // Previously failed work deserves quick retry
  github_issue_ready:  70,  // Issue marked ready, time-sensitive
  coding_todo:         50,  // Scheduled coding work
  github_issue:        40,  // General issue triage
  health_check:        30,  // Lowest: background health monitoring
};

function getWeight(item) {
  return SOURCE_WEIGHTS[item.source] || 0;
}

function sortByPriority(items) {
  return items.sort((a, b) => getWeight(b) - getWeight(a));
}
```

### Conflict Check

Before dispatching a worker to a repository, the dispatcher checks for conflicts based on task type. Worktree-isolated task types (`solve_issue`, `solve-issue`, `self-improve`, `coding`) can safely run in parallel on the same repo because each operates in its own git worktree. Non-worktree tasks require exclusive access:

```javascript
// worker/conflict-check.js
const WORKTREE_TASK_TYPES = ['solve_issue', 'solve-issue', 'self-improve', 'coding'];

function canDispatch(item, runningRepos) {
  const repo = item.resource || item.workdir;
  if (!repo) return true;

  const running = runningRepos.get(repo);
  if (!running) return true;

  // Multiple worktree tasks on same repo = safe, can run parallel
  if (WORKTREE_TASK_TYPES.includes(item.taskType) &&
      running.every(r => WORKTREE_TASK_TYPES.includes(r.taskType))) {
    return true;
  }

  // One non-worktree task on repo = defer other tasks (potential conflict)
  audit.log('dispatcher:skip_item', {
    reason: 'repo_conflict',
    repo,
    source: item.source,
  });
  return false;
}
```

### Dispatch Loop

The dispatcher collects work from all sources via `identifyWork()`, filters by parallel limits, budget, and conflicts, then dispatches the highest-scoring items:

```javascript
async function dispatch() {
  const candidates = await identifyWork();  // Collect from all sources with weights
  const sorted = sortByPriority(candidates);
  const availableWorkers = getAvailableWorkerCount();

  let dispatched = 0;

  for (const item of sorted) {
    if (dispatched >= availableWorkers) break;
    if (!canDispatch(item, runningRepos)) continue;

    // Track running repos to prevent simultaneous non-worktree tasks
    trackRepo(item);

    await dispatchToWorker(item);
    dispatched++;

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
const MAX_PARALLEL_WORKERS = parseInt(process.env.MAX_PARALLEL_WORKERS) || 3;

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
- Conflict checking distinguishes worktree-isolated tasks (which can run in parallel on the same repo) from non-worktree tasks (which require exclusive access). This handles the most common safe-parallel case without over-locking.
- Budget tracking is advisory (warns but doesn't stop) — hard budget enforcement would require a policy decision about which events to drop.
- The tick interval creates a maximum latency of one tick between an event arriving and dispatch. Sub-second dispatch requires a tighter interval at the cost of more CPU.
- Audit logging enables replay and diagnosis but generates volume — needs rotation or aggregation.
- Worker count caps prevent overload but can create backlogs during high-demand periods.

## Code Example

```javascript
// Complete dispatch cycle with priority, conflict checks, and budget
async function dispatchCycle() {
  const candidates = sortByPriority(await identifyWork());
  const available = getAvailableWorkerCount();

  for (const item of candidates.slice(0, available)) {
    const repo = item.resource || item.workdir;

    // Skip if repo has a conflict (non-worktree task running)
    if (!canDispatch(item, runningRepos)) continue;

    // Track repo and dispatch
    if (repo) trackRepo(item);

    audit.log('dispatcher:dispatch', {
      source: item.source,
      weight: getWeight(item),
      repo,
    });

    dispatchToWorker(item).finally(() => {
      if (repo) untrackRepo(item);
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
