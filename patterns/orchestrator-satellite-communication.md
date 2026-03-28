# Orchestrator-Worker Communication

> Multi-source weighted scoring dispatcher that collects work from heterogeneous sources, scores each item by source weight plus item-specific factors, and dispatches to typed workers with repo-locking and budget checks.

## Problem

An orchestrator needs to dispatch heterogeneous work (user requests, GitHub issues, retryable failures, coding todos, health fixes) to AI agent workers. Work arrives from many sources with wildly different urgency: a user request should jump ahead of a speculative GitHub issue triage. Without a scoring model that accounts for source priority, item-specific factors, repo contention, and API budget, the dispatcher either starves urgent work or burns budget on low-value tasks while a user waits.

## Context

- A central orchestrator dispatching work to Claude Code CLI processes
- Work arrives from 6+ sources: user requests, retryable failed tasks, worker-ready GitHub issues, solvable GitHub issues, coding todos, and health checks
- Workers are typed (research, code-review, communication, data, coding) with per-type capabilities, autonomy tiers, system prompts, and timeouts
- Multiple workers can run in parallel, but two non-isolated workers cannot work on the same repository simultaneously
- API budget is finite and tracked per task

## Solution

### Architecture Overview

The dispatcher runs a collect-score-filter-dispatch pipeline. It gathers candidate work from all sources, scores each item using a base weight for the source plus item-specific adjustments, filters out repo-locked items, sorts by score, then dispatches the top N items that fit within available worker slots and budget.

```
Work Sources                    Dispatcher Pipeline
  user requests  ─┐
  retry failures ─┤
  GH issues      ─┤──→  identifyWork()
  coding todos   ─┤       │
  health checks  ─┘       ├─ score = SOURCE_WEIGHT + itemFn(item)
                          ├─ filter repo-locked items
                          ├─ sort by score DESC
                          │
                      dispatch()
                          ├─ check worker slot capacity
                          ├─ check budget per item
                          └─ route to typed dispatch runner
```

### Source Weights and Scoring

Each work source has a base weight. Items within a source get additional scoring from an item-specific function:

```javascript
// lib/worker/dispatcher.js
const SOURCE_WEIGHTS = {
  user_request: 90,
  retry_failed: 80,
  github_issue_ready: 70,
  coding_todo: 50,
  github_issue: 40,
  health_check: 30,
};

// Each source defines its scoring function
const sources = [
  {
    fn: getPendingUserTasks,
    source: 'user_request',
    scoreBase: SOURCE_WEIGHTS.user_request,
    scoreFn: (t) => t.priority || 0,       // User-set priority adds to base
    cost: 20,
    taskType: (t) => t.task_type,
  },
  {
    fn: getRetryableTasks,
    source: 'retry_failed',
    scoreBase: SOURCE_WEIGHTS.retry_failed,
    scoreFn: (t) => -(t.attempt_count || 0) * 10,  // Penalize repeated failures
    cost: 20,
  },
  {
    fn: getSolvableIssues,
    source: 'github_issue',
    scoreBase: SOURCE_WEIGHTS.github_issue,
    scoreFn: (i) => i.solvabilityScore * 2,  // Solvability score boosts ranking
    cost: 25,
  },
  // ... coding_todo, github_issue_ready, health_check
];
```

The final score for any item is `scoreBase + scoreFn(item)`. A user request with priority 5 scores 95; a GitHub issue with solvability 4 scores 48.

### Worker Type Registry

Workers are typed with explicit capabilities, autonomy tiers, system prompts, and concurrency limits. Task types are mapped to worker types through direct mappings and capability matching:

```javascript
// lib/worker/worker-types.js
const WORKER_TYPES = {
  research: {
    capabilities: ['web_search', 'document_analysis', 'summarization', 'research'],
    autonomyTier: APPROVAL_TIERS.AUTO,  // Read-only, safe to auto-execute
    timeout: 600000,   // 10 minutes
    maxParallel: 2,
    systemPrompt: `You are a research specialist...`,
  },
  coding: {
    capabilities: ['code_execution', 'bug_fix', 'feature_implementation', 'solve_issue'],
    autonomyTier: APPROVAL_TIERS.NOTIFY,
    timeout: 1800000,  // 30 minutes
    maxParallel: 3,
    systemPrompt: `You are a coding specialist...`,
  },
  // communication, code-review, data...
};

function findWorkerTypeForTask(taskTypeOrCapability) {
  // Direct mapping first: solve_issue -> coding, pr_review -> code-review
  if (directMappings[normalized]) return directMappings[normalized];
  // Then capability scan, then default to 'coding'
  return 'coding';
}
```

### Repo Locking

The dispatcher prevents two non-isolated workers from operating on the same repository simultaneously. Before dispatching, it builds a set of repos with active tasks and filters out items targeting those repos:

```javascript
// lib/worker/repo-lock.js
const activeRepos = new Map(); // repo -> Set<taskId>

function canWorkOnRepo(repo, taskId, hasWorktreeIsolation = false) {
  if (!repo) return true;
  const active = activeRepos.get(repo);
  if (!active || active.size === 0) return true;
  if (active.has(taskId)) return true;
  if (hasWorktreeIsolation) return true;  // Worktrees can run in parallel
  return false;
}
```

In `identifyWork()`, the dispatcher builds the running repo set from active tasks and filters candidates:

```javascript
const runningRepos = new Set();
for (const task of running) {
  const repo = extractRepo(task.params);
  if (repo) runningRepos.add(repo);
}

const filteredWork = work.filter((item) => {
  const repo = extractRepo(item);
  if (repo && runningRepos.has(repo)) return false;
  return true;
});

return filteredWork.sort((a, b) => b.score - a.score);
```

### Budget-Gated Dispatch

Each work item carries an estimated cost. Before dispatching, the system checks whether budget allows the task:

```javascript
async function dispatch() {
  const work = await identifyWork();
  const slotsAvailable = MAX_PARALLEL_WORKERS - running.length;

  for (const workItem of work.slice(0, slotsAvailable)) {
    const budgetCheck = ccUsage.shouldExecuteTask(2, workItem.estimatedCost);
    if (!budgetCheck.allowed) {
      audit.log('dispatcher:budget_blocked', {
        source: workItem.source,
        estimatedCost: workItem.estimatedCost,
      });
      break;  // Budget exhausted — stop dispatching
    }

    const handler = dispatchers[workItem.source];
    const result = await handler(workItem.item);
    if (result.success) {
      ccUsage.logTaskExecution('worker_dispatch', workItem.estimatedCost, 2);
    }
  }
}
```

## Implications

- Source weights make priority explicit and tunable: user requests (90) always outrank health checks (30) regardless of item-specific scoring
- Item-specific scoring allows nuance within a source: a retried task with 2 prior failures is penalized (-20) relative to a fresh retry
- Repo locking prevents git conflicts but can create starvation: if a long-running coding task holds a repo, all other items for that repo queue behind it
- Worktree isolation is the escape hatch: tasks that use git worktrees bypass repo locking entirely
- Budget checking is a hard gate with early termination: once budget is exhausted, no more items dispatch in that cycle, even if worker slots are available
- `MAX_PARALLEL_WORKERS` (default 3) is the global concurrency cap, while each worker type has its own `maxParallel` for finer control
- The solvability scorer for GitHub issues uses label heuristics (bug: +2, good-first-issue: +3) and title keywords (typo: +2, redesign: -3), meaning it can be gamed by label conventions

## Code Example

```javascript
// End-to-end dispatch cycle

// 1. identifyWork() collects from all sources:
//    user_request (priority 5)  → score: 90 + 5  = 95
//    retry_failed (attempt 2)   → score: 80 - 20 = 60
//    github_issue (solvability 4) → score: 40 + 8 = 48
//    health_check (ci_failure)  → score: 30 + 5  = 35

// 2. Repo filter removes github_issue (repo already has active task)

// 3. Sorted: [user_request:95, retry_failed:60, health_check:35]

// 4. dispatch() with 2 slots available:
//    - user_request: budget check passes → dispatched via dispatchUserRequest()
//    - retry_failed: budget check passes → dispatched via dispatchRetry()
//    - health_check: no slots left → waits for next cycle

// 5. Status endpoint reports:
const status = await dispatcher.getStatus();
// {
//   runningTasks: 2,
//   availableWork: 1,
//   topWork: [{ source: 'health_check', score: 35 }],
//   budget: { remaining: 60, status: 'ok' }
// }
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Distributed Job Locking](./distributed-job-locking.md)
