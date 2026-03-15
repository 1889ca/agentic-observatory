# Worker Dispatcher and Priority Queue

> Weighted work source prioritization with repo-level locking and budget tracking for dispatching satellite workers without concurrent edit conflicts.

## Problem

An orchestrator receives work from many sources — user requests, retries, GitHub issues, health checks, coding TODOs. Each source has different urgency, but a naive FIFO queue means a flood of low-priority health checks can delay a user's urgent request. Additionally, two workers editing the same repository simultaneously can create merge conflicts, corrupt state, or produce contradictory changes.

## Context

- Multiple work sources with different urgency levels feeding a shared dispatch queue
- Satellite workers that edit code in project repositories
- Risk of concurrent edits to the same repository from different workers
- Need for budget tracking to prevent runaway cost
- Some work items can safely run in parallel (worktree-isolated tasks)

## Solution

### Weighted Source Prioritization

Each work source is assigned a static weight. When the dispatcher ticks, it evaluates all pending items and processes highest-weight items first:

```javascript
// worker/dispatcher.js
const SOURCE_WEIGHTS = {
  user_request:       90,  // Highest: human is waiting
  retry_failed:       80,  // Retry before new work
  github_issue_ready: 70,  // Pre-triaged, ready to work
  coding_todo:        50,  // Important but not urgent
  github_issue:       40,  // Needs triage first
  health_check:       30,  // Lowest: background maintenance
};

function getWeight(item) {
  return SOURCE_WEIGHTS[item.source] || 0;
}

function sortByPriority(items) {
  return items.sort((a, b) => getWeight(b) - getWeight(a));
}
```

### Repo-Level Locking

Before dispatching a worker to a repository, the dispatcher checks whether another worker is already editing that repo. This prevents concurrent edits that would cause merge conflicts:

```javascript
// worker/repo-lock.js
const runningRepos = new Map(); // repo → { workerId, startedAt }

function canDispatch(item) {
  const repo = item.repo || item.workdir;
  if (!repo) return true; // No repo context — allow

  if (runningRepos.has(repo)) {
    // Exception: worktree-isolated tasks can run in parallel
    if (item.isolation === 'worktree') return true;

    audit.log('dispatcher:skip_item', {
      reason: 'repo_in_use',
      repo,
      source: item.source,
    });
    return false;
  }

  return true;
}

function lockRepo(repo, workerId) {
  runningRepos.set(repo, { workerId, startedAt: Date.now() });
}

function unlockRepo(repo) {
  runningRepos.delete(repo);
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

    const repo = item.repo || item.workdir;
    if (repo) lockRepo(repo, item.id);

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
  repo: item.repo,
  model: item.model,
  queueDepth: pending.length,
});
```

## Implications

- Static weights are simple but inflexible — a user request always beats a GitHub issue, even if the issue is critical and the request is trivial. Dynamic weight adjustment could address this but adds complexity.
- Repo-level locking is coarse — two workers could safely edit different parts of the same repo, but the lock prevents it. The worktree exception handles the most common safe-parallel case.
- Budget tracking is advisory (warns but doesn't stop) — hard budget enforcement would require a policy decision about which work to drop.
- The tick interval creates a maximum latency of one tick between work arriving and dispatch. Sub-second dispatch requires a tighter interval at the cost of more CPU.
- Audit logging enables replay and diagnosis but generates volume — needs rotation or aggregation.
- Worker count caps prevent overload but can create backlogs during high-demand periods.

## Code Example

```javascript
// Complete dispatch cycle with priority, locking, and budget
async function dispatchCycle() {
  const pending = sortByPriority(await getPendingItems());
  const available = getAvailableWorkerCount();

  for (const item of pending.slice(0, available)) {
    const repo = item.repo || item.workdir;

    // Skip if repo is busy (unless worktree-isolated)
    if (repo && runningRepos.has(repo) && item.isolation !== 'worktree') {
      continue;
    }

    // Lock repo and dispatch
    if (repo) lockRepo(repo, item.id);

    audit.log('dispatcher:dispatch', {
      source: item.source,
      weight: getWeight(item),
      repo,
    });

    dispatchToWorker(item).finally(() => {
      if (repo) unlockRepo(repo);
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
