# Worker Dispatcher and Priority Queue

> Weighted priority scoring with budget gating where work items from 6 sources are scored by SOURCE_WEIGHTS plus item-specific factors, then dispatched in score order with per-item budget checks and repo-lock filtering.

## Problem

An orchestrator receives work from many sources -- user requests, retryable failures, GitHub issues, coding todos, health checks. These vary wildly in urgency and cost. Without explicit priority scoring, the dispatcher either processes items in arrival order (starving urgent user requests behind a queue of speculative issue triages) or uses a single FIFO queue (treating a user request the same as a background health check). The system needs a scoring model that encodes source-level priority, item-level nuance, and budget constraints.

## Context

- Work arrives from 6 heterogeneous sources with different urgency profiles
- A pool of workers with a configurable concurrency limit (default 3)
- Finite API budget that must be checked before each dispatch
- Repositories that should not have two non-isolated workers operating simultaneously
- Need for observability: every dispatch decision and skip must be auditable

## Solution

### SOURCE_WEIGHTS: Explicit Priority by Origin

Each work source has a base weight that establishes its priority tier. This is the foundation of the scoring model:

```javascript
// lib/worker/dispatcher.js
const SOURCE_WEIGHTS = {
  user_request: 90,        // Highest: user is waiting
  retry_failed: 80,        // High: already failed once, don't let it rot
  github_issue_ready: 70,  // Medium-high: triaged and tagged for work
  coding_todo: 50,         // Medium: scheduled but not urgent
  github_issue: 40,        // Medium-low: speculative, might not be solvable
  health_check: 30,        // Low: maintenance, not user-facing
};
```

### Item-Level Score Adjustments

Within each source, items get additional scoring from source-specific functions. These functions encode domain knowledge about what makes an item more or less urgent:

```javascript
const sources = [
  {
    fn: getPendingUserTasks,
    source: 'user_request',
    scoreBase: SOURCE_WEIGHTS.user_request,
    scoreFn: (t) => t.priority || 0,
    // User-set priority adds directly: a priority-5 request scores 95
  },
  {
    fn: getRetryableTasks,
    source: 'retry_failed',
    scoreBase: SOURCE_WEIGHTS.retry_failed,
    scoreFn: (t) => -(t.attempt_count || 0) * 10,
    // Penalize repeated failures: attempt 2 scores 60, attempt 3 scores 50
  },
  {
    fn: getSolvableIssues,
    source: 'github_issue',
    scoreBase: SOURCE_WEIGHTS.github_issue,
    scoreFn: (i) => i.solvabilityScore * 2,
    // Solvability from label/title heuristics: score 5 → +10, total 50
  },
  {
    fn: getCodingTodos,
    source: 'coding_todo',
    scoreBase: SOURCE_WEIGHTS.coding_todo,
    scoreFn: (t) => (t.priority === 'urgent' ? 20 : t.priority === 'high' ? 10 : 0),
    // Named priorities: urgent todo scores 70, high scores 60, normal scores 50
  },
];
```

Final score: `sourceBase + scoreFn(item)`. Items are sorted descending by score.

### Solvability Scoring for GitHub Issues

GitHub issues are scored for solvability using a heuristic that considers labels, title keywords, and age:

```javascript
// lib/worker/work-sources.js
function scoreSolvability(issue) {
  let score = 0;

  // Label signals
  if (issue.labels.includes('bug')) score += 2;
  if (issue.labels.includes('good-first-issue')) score += 3;
  if (issue.labels.includes('help-wanted')) score += 2;
  if (issue.labels.includes('documentation')) score += 2;

  // Title keyword signals
  if (title.includes('fix')) score += 1;
  if (title.includes('typo')) score += 2;
  if (title.includes('refactor')) score -= 2;
  if (title.includes('redesign')) score -= 3;
  if (title.includes('breaking')) score -= 3;

  // Age penalty
  if (ageInDays > 30) score -= 1;
  if (ageInDays > 90) score -= 2;

  return score;
}

// Only issues scoring >= 3 are considered dispatchable
```

### Budget-Gated Dispatch

Each work item carries an estimated cost. Before dispatching, the system checks API budget. If budget is exhausted, dispatch stops entirely for that cycle:

```javascript
async function dispatch() {
  const autonomyCheck = await canJobRun('worker-dispatch');
  if (!autonomyCheck.allowed) return { dispatched: false, reason: autonomyCheck.reason };

  const work = await identifyWork();
  const running = await workerTasks.getRunning();
  const slotsAvailable = Math.max(0, MAX_PARALLEL_WORKERS - running.length);

  for (const workItem of work.slice(0, slotsAvailable)) {
    const budgetCheck = ccUsage.shouldExecuteTask(2, workItem.estimatedCost);
    if (!budgetCheck.allowed) {
      audit.log('dispatcher:budget_blocked', {
        source: workItem.source,
        estimatedCost: workItem.estimatedCost,
        reason: budgetCheck.reason,
      });
      break;  // Budget exhausted — stop dispatching entirely
    }

    const handler = dispatchers[workItem.source];
    const result = await handler(workItem.item);

    if (result.success) {
      audit.log('dispatcher:dispatched', {
        source: workItem.source,
        taskId: result.taskId,
      });
      ccUsage.logTaskExecution('worker_dispatch', workItem.estimatedCost, 2);
    }
  }
}
```

The `break` on budget exhaustion is deliberate: if the budget can't afford item N, it certainly can't afford item N+1 (items are sorted by priority, not by cost). This prevents the system from skipping an expensive high-priority item to dispatch a cheap low-priority one.

### Repo-Lock Filtering

Before scoring, the dispatcher filters out items targeting repositories that already have active workers:

```javascript
async function identifyWork() {
  const running = await workerTasks.getRunning();

  // Build set of repos currently being worked on
  const runningRepos = new Set();
  for (const task of running) {
    const repo = extractRepo(task.params);
    if (repo) runningRepos.add(repo);
  }

  // Collect work from all sources...
  const work = [...];

  // Filter out repo-locked items
  return work.filter(item => {
    const repo = extractRepo(item);
    if (repo && runningRepos.has(repo)) {
      audit.log('dispatcher:skip_item', { reason: 'repo_in_use', repo, source: item.source });
      return false;
    }
    return true;
  }).sort((a, b) => b.score - a.score);
}
```

### Estimated Cost by Source

Each source carries a default estimated cost (in API credits):

| Source | Estimated Cost | Rationale |
|--------|---------------|-----------|
| user_request | 20 | Focused task, usually bounded |
| retry_failed | 20 | Same scope as original task |
| github_issue_ready | 25 | May need code analysis + fix |
| github_issue | 25 | Requires solvability assessment + fix |
| coding_todo | 20 | Bounded by todo description |
| health_check (CI failure) | 20 | Diagnosis + fix |
| health_check (other) | 15 | Usually lighter maintenance |

### Source-Specific Dispatch Runners

Each source has its own dispatch runner that handles the specifics of creating and executing the task:

```javascript
const dispatchers = {
  user_request: dispatchUserRequest,
  github_issue_ready: dispatchWorkerReadyIssue,
  github_issue: dispatchGitHubIssue,
  retry_failed: dispatchRetry,
  health_check: dispatchHealthFix,
  coding_todo: dispatchCodingTodo,
};
```

### Status Endpoint

The dispatcher exposes a status summary that shows running tasks, available work (with scores), and budget state:

```javascript
async function getStatus() {
  const [running, pending, work] = await Promise.all([
    workerTasks.getRunning(),
    workerTasks.getPending(),
    identifyWork(),
  ]);
  const budget = ccUsage.getBudgetStatus();

  return {
    isActive: running.length > 0,
    runningTasks: running.length,
    pendingTasks: pending.length,
    availableWork: work.length,
    topWork: work.slice(0, 5).map(w => ({
      source: w.source, score: w.score,
      title: w.item.title || w.item.description,
      estimatedCost: w.estimatedCost,
    })),
    budget: { remaining: budget.remaining, status: budget.status },
  };
}
```

## Implications

- Source weights make inter-source priority explicit and tunable: changing `github_issue` from 40 to 60 would prioritize it over coding todos without touching any other code
- The `break` on budget exhaustion means a single expensive high-priority item can block all subsequent dispatches in a cycle, even if budget exists for cheaper items. This is a correctness trade-off: it prevents priority inversion at the cost of potential under-utilization
- Solvability scoring is heuristic: it rewards conventional labels (`good-first-issue`, `bug`) and penalizes ambiguous work (`refactor`, `redesign`). Issues with non-standard labeling will be misjudged
- Repo locking prevents git conflicts but can create priority inversion: a low-priority health check on repo X blocks a high-priority user request for the same repo
- Retryable tasks are penalized per attempt, creating a natural decay: a task that fails 3 times scores 50 (vs 80 for a fresh retry), making it less likely to consume a worker slot over newer work
- The estimated cost per source is static, not computed from the actual task content. A simple typo fix and a complex refactor both cost 25 credits if they're both GitHub issues
- `MAX_PARALLEL_WORKERS` (default 3) is the hard concurrency cap. Increasing it requires more Claude API budget but reduces queue wait times
- Every dispatch decision and skip is audit-logged, enabling post-mortem analysis of why specific items waited or were blocked

## Code Example

```javascript
// Dispatch cycle with 3 max workers, 1 currently running

// identifyWork() returns (sorted by score):
// 1. user_request  (priority 3) → 90 + 3  = 93
// 2. retry_failed  (attempt 1)  → 80 - 10 = 70
// 3. coding_todo   (urgent)     → 50 + 20 = 70  (tie: arrival order)
// 4. github_issue  (solvab. 5)  → 40 + 10 = 50
// 5. health_check  (ci_failure) → 30 + 5  = 35

// 2 slots available (3 max - 1 running)

// Item 1 (user_request, score 93):
//   Budget check: 20 credits → allowed
//   Dispatch via dispatchUserRequest() → success
//   audit.log('dispatcher:dispatched', { source: 'user_request', ... })

// Item 2 (retry_failed, score 70):
//   Budget check: 20 credits → allowed
//   Dispatch via dispatchRetry() → success

// Items 3-5: no slots left → wait for next cycle

// Status after dispatch:
// {
//   runningTasks: 3,
//   availableWork: 3,
//   topWork: [
//     { source: 'coding_todo', score: 70 },
//     { source: 'github_issue', score: 50 },
//     { source: 'health_check', score: 35 },
//   ],
//   budget: { remaining: 60, status: 'ok' }
// }
```

## Related Patterns

- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
