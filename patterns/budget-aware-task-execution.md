# Budget-Aware Task Execution

> Pre-dispatch budget checking via `shouldExecuteTask()` that gates autonomous work by urgency, weekly spend, burn rate, and remaining budget -- preventing runaway spending while still allowing critical tasks through.

## Problem

An AI orchestrator that autonomously dispatches work to Claude Code workers can accumulate significant API costs. Without budget controls, a busy week of self-improvements, issue solving, and health fixes can blow through hundreds of dollars before anyone notices. But a hard spending cap is too blunt -- a critical production fix should still go through even when the budget is tight, while a low-priority code cleanup should wait.

## Context

- An orchestrator dispatching Claude Code worker tasks on a cron schedule (every 20 minutes during work hours)
- Each task has an estimated cost ($10-25 depending on type)
- Weekly budget is configurable (default $750/week, resetting on a configurable day)
- Usage data comes from the `ccusage` CLI tool which reads local Claude data
- Different work sources have different urgency levels (user requests > retries > issues > health checks)
- The system runs in two modes: local (with budget tracking) and cloud (budget tracking disabled)

## Solution

### Budget Status Calculation

The usage module fetches spending data from the `ccusage` CLI, caches it for 5 minutes, and computes a comprehensive budget status with utilization thresholds:

```javascript
// lib/claude/usage.js
const WEEKLY_BUDGET = parseFloat(process.env.CC_WEEKLY_BUDGET) || 750
const CRITICAL_THRESHOLD = 0.9   // 90% used
const WARNING_THRESHOLD = 0.75   // 75% used
const CONSERVATIVE_THRESHOLD = 0.5 // 50% used

function getBudgetStatus() {
  const weeklySpend = getWeeklySpend()
  const remaining = Math.max(0, WEEKLY_BUDGET - weeklySpend)
  const utilization = weeklySpend / WEEKLY_BUDGET
  const burnRate = getBurnRate() // $/hour over last 3 days
  const hoursRemaining = getHoursRemaining()
  const projectedSpend = weeklySpend + burnRate * hoursRemaining

  let status = 'healthy'
  if (utilization >= CRITICAL_THRESHOLD) status = 'critical'
  else if (utilization >= WARNING_THRESHOLD) status = 'warning'
  else if (utilization >= CONSERVATIVE_THRESHOLD) status = 'conservative'

  return {
    weeklyBudget: WEEKLY_BUDGET,
    weeklySpend, remaining, utilization,
    burnRate, projectedSpend,
    hoursRemaining, status,
    canAffordTask: remaining >= 10,
    tasksRemaining: Math.floor(remaining / 10),
    recommendedDailyBudget: remaining / Math.ceil(hoursRemaining / 24),
  }
}
```

### Urgency-Gated Decision Function

The `shouldExecuteTask()` function cross-references budget status with task urgency to produce an allow/deny decision with a reason string:

```javascript
// lib/claude/usage.js
function shouldExecuteTask(urgency = 2, estimatedCost = 10) {
  if (IS_CLOUD) {
    return { allowed: true, reason: 'Cloud mode - no local budget tracking' }
  }

  const status = getBudgetStatus()

  // Critical urgency (4+): allow if budget exists at all
  if (urgency >= 4 && status.remaining >= estimatedCost) {
    return { allowed: true, reason: 'Critical task - budget available' }
  }

  // Critical budget: only high-urgency tasks
  if (status.status === 'critical') {
    if (urgency >= 3) {
      return {
        allowed: status.remaining >= estimatedCost,
        reason: status.remaining >= estimatedCost
          ? 'High urgency task allowed despite critical budget'
          : 'Insufficient budget for task',
      }
    }
    return { allowed: false, reason: `Budget critical (${status.utilization}% used)` }
  }

  // Warning budget: medium+ urgency only
  if (status.status === 'warning') {
    if (urgency >= 2) {
      return { allowed: true, reason: 'Medium+ urgency task allowed during warning' }
    }
    return { allowed: false, reason: `Budget warning - deferring low-urgency tasks` }
  }

  // Conservative: allow most tasks unless very low urgency and few tasks remaining
  if (status.status === 'conservative') {
    if (urgency >= 2 || status.tasksRemaining > 10) {
      return { allowed: true, reason: 'Task allowed - conservative mode' }
    }
    return { allowed: false, reason: 'Conservative mode - deferring low-urgency tasks' }
  }

  return { allowed: true, reason: 'Budget healthy' }
}
```

### Integration With Worker Dispatcher

The dispatcher checks budget before each work item in priority order. When budget is exhausted, it `break`s out of the dispatch loop -- since items are sorted by score, if the current item can't afford execution, neither can lower-priority items:

```javascript
// lib/worker/dispatcher.js
async function dispatch() {
  const autonomyCheck = await canJobRun('worker-dispatch')
  if (!autonomyCheck.allowed) return { dispatched: false, reason: autonomyCheck.reason }

  const work = await identifyWork()
  // work is sorted by score (user_request=90, retry=80, issue=70, todo=50, health=30)

  for (const workItem of work.slice(0, slotsAvailable)) {
    const budgetCheck = ccUsage.shouldExecuteTask(2, workItem.estimatedCost)
    if (!budgetCheck.allowed) {
      audit.log('dispatcher:budget_blocked', {
        source: workItem.source,
        estimatedCost: workItem.estimatedCost,
        reason: budgetCheck.reason,
      })
      break // Budget exhausted for remaining items too
    }

    const handler = dispatchers[workItem.source]
    const result = await handler(workItem.item)

    if (result.success) {
      ccUsage.logTaskExecution('worker_dispatch', workItem.estimatedCost, 2)
    }
  }
}
```

### Work Source Cost Estimation

Each work source declares its estimated cost, allowing the dispatcher to make informed budget decisions:

```javascript
// lib/worker/dispatcher.js
const sources = [
  { fn: getPendingUserTasks,   source: 'user_request',       cost: 20, scoreBase: 90 },
  { fn: getRetryableTasks,     source: 'retry_failed',       cost: 20, scoreBase: 80 },
  { fn: getWorkerReadyIssues,  source: 'github_issue_ready', cost: 25, scoreBase: 70 },
  { fn: getSolvableIssues,     source: 'github_issue',       cost: 25, scoreBase: 40 },
  { fn: getCodingTodos,        source: 'coding_todo',        cost: 20, scoreBase: 50 },
]
// Health checks: ci_failure=$20, other=$15
```

### Budget Status in Dispatch Status

The dispatcher's status endpoint exposes budget state so the UI and monitoring can show remaining capacity:

```javascript
// lib/worker/dispatcher.js
async function getStatus() {
  const [running, pending, work] = await Promise.all([
    workerTasks.getRunning(), workerTasks.getPending(), identifyWork(),
  ])
  const budget = ccUsage.getBudgetStatus()

  return {
    isActive: running.length > 0,
    runningTasks: running.length,
    availableWork: work.length,
    budget: {
      remaining: budget.remaining,
      status: budget.status,
      canAffordTask: budget.canAffordTask,
    },
  }
}
```

## Implications

- The four-tier budget status (healthy/conservative/warning/critical) creates progressively tighter gates, preventing cliff-edge behavior where spending is unrestricted until a hard cap
- Urgency levels (1-4) interact with budget tiers, so critical production fixes (urgency 4) can still execute when the budget is nearly exhausted, while low-priority cleanups (urgency 1) get deferred early
- The `break` on budget denial in the dispatch loop is an intentional optimization -- since all remaining items have equal or lower priority, checking them is wasteful
- Usage data is cached for 5 minutes, so rapid successive dispatches see the same budget snapshot. This prevents thrashing but means the system could slightly overshoot if many tasks execute within a cache window
- The `estimatedCost` per work source is a static estimate, not actual cost. Actual costs vary based on task complexity, so the budget tracking is approximate
- Cloud mode (`DB_BACKEND=postgres`) disables all budget tracking because there's no local Claude data directory. This means cloud deployments have no spending guardrails from this module
- The weekly reset day is configurable via `CC_WEEKLY_RESET_DAY`, defaulting to Thursday (day 4), aligning with billing cycles
- Burn rate is calculated from the last 3 days, smoothing out daily spikes while still reacting to sustained high usage

## Code Example

```javascript
// Before dispatching any autonomous work
const budgetCheck = ccUsage.shouldExecuteTask(
  2,  // urgency: medium (normal autonomous work)
  20  // estimatedCost: $20 for a coding task
)

if (!budgetCheck.allowed) {
  console.log(`Skipping task: ${budgetCheck.reason}`)
  // "Budget warning (78% used) - deferring low-urgency tasks"
  return
}

// Get a human-readable summary for monitoring
console.log(ccUsage.getSummary())
// 🟡 CC Budget: $562.40/$750 (75%)
// Remaining: $187.60 | ~18 tasks
// Burn rate: $3.20/hr | Projected: $724.80
// Days left: 2 | Recommended: $93.80/day
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
