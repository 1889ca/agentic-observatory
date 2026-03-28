# Proactive Intelligence Job

> A consolidated autonomous cycle that replaces multiple standalone scheduled jobs with a single work-hour-aware job group, unifying autonomous thinking, worker dispatch, context sync, stuck task detection, and proactive context gathering under one schedule.

## Problem

An orchestrator accumulates specialized scheduled jobs over time -- autonomous thinking every 30 minutes, worker dispatch every 20, context sync every 15, stuck task detection every 2 hours, context prefetch every 5, stale PR checks, issue solving, and inbox refresh. Each has its own cron schedule, autonomy check, work-hour guard, and logging. This leads to schedule collisions (multiple jobs firing in the same minute), redundant autonomy checks, inconsistent work-hour windows, and an explosion of cron entries that are hard to reason about as a whole.

## Context

- Eight standalone jobs that collectively form the orchestrator's "proactive intelligence" -- the things it does without being asked
- Each job already has autonomy gating (`canJobRun()`), audit tracking, and orchestrator logging
- Jobs have overlapping concerns: worker dispatch needs to know about stuck tasks, context prefetch relates to context sync, autonomous thinking should know about budget status
- All jobs share the same constraint: only run during work hours (typically 9 AM - 6 PM, Monday-Friday)
- Budget awareness should apply across all proactive work, not just worker dispatch

## Solution

### Job Consolidation Into Semantic Groups

Rather than running 8+ independent cron jobs, the proactive intelligence job consolidates them into a single entry point that runs sub-tasks in a logical order with shared context:

```javascript
// jobs/proactive-intelligence.js (conceptual -- consolidates these disabled jobs)
//
// Replaces:
//   autonomous-agent.js    — every 30 min, work hours (enabled: false)
//   worker-dispatch.js     — every 20 min, work hours (enabled: false)
//   context-sync.js        — every 15 min (enabled: false)
//   context-prefetch.js    — every 5 min (enabled: false)
//   stuck-task-detector.js — every 2 hours, 9-9 (enabled: false)
//   stale-prs.js           — periodic (enabled: false)
//   issue-solver.js        — periodic (enabled: false)
//   action-inbox-refresh.js — every 15 min (enabled: false)
```

The old jobs remain in the codebase with `enabled: false` and a comment pointing to the consolidation:

```javascript
// From autonomous-agent.js
module.exports = {
  name: 'autonomous-agent',
  schedule: schedules.SCHEDULES.AUTONOMOUS_AGENT,
  autonomyLevel: 'NOTIFY',
  enabled: false, // Consolidated into semantic job group jobs/proactive-intelligence.js
  run,
}
```

### Work-Hour Awareness

All proactive intelligence shares a single work-hour check rather than each job implementing its own. The cron expression `*/20 9-18 * * 1-5` (every 20 minutes, 9 AM to 6 PM, weekdays) replaces eight separate schedules:

```javascript
// Original: 8 different cron expressions
// autonomous-agent:     '*/30 9-18 * * 1-5'
// worker-dispatch:      '*/20 9-18 * * 1-5'
// context-sync:         '*/15 * * * *'       (ran outside work hours!)
// context-prefetch:     '*/5 * * * *'        (ran outside work hours!)
// stuck-task-detector:  '0 */2 9-21 * * *'
// stale-prs:            periodic
// issue-solver:         periodic
// action-inbox-refresh: '*/15 * * * *'       (ran outside work hours!)

// Consolidated: single schedule with sub-task frequency control
```

### Tiered Sub-Task Execution

Within the consolidated job, sub-tasks run at different effective frequencies by checking elapsed time since their last run:

```javascript
// Conceptual execution order within proactive-intelligence cycle:
//
// EVERY CYCLE (every 20 min):
//   1. Context sync — sync calendar events to behavioral overrides
//   2. Action inbox refresh — refresh action items from sources
//   3. Worker dispatch — identify and dispatch work to CC workers
//
// EVERY OTHER CYCLE (~40 min):
//   4. Autonomous agent — thinking cycle, reflect on state, queue actions
//
// EVERY 6 CYCLES (~2 hours):
//   5. Stuck task detector — find and handle stuck in-progress tasks
//   6. Stale PR check — flag PRs that need attention
//
// Context prefetch runs on its own lighter schedule (every 5 min)
// since it's read-only and low-cost
```

### Shared Budget Gate

Instead of only the worker dispatcher checking budget, the consolidated job applies budget awareness across all proactive sub-tasks. The autonomous agent cycle, which can queue and execute actions, respects the same budget constraints:

```javascript
// From the dispatcher (applies to the whole proactive cycle)
const budgetCheck = ccUsage.shouldExecuteTask(2, workItem.estimatedCost)
if (!budgetCheck.allowed) {
  audit.log('dispatcher:budget_blocked', {
    source: workItem.source,
    estimatedCost: workItem.estimatedCost,
    reason: budgetCheck.reason,
  })
  break
}
```

### Autonomous Thinking With Orchestrator Integration

The autonomous agent sub-task (formerly standalone) runs the agent's thinking cycle, logs decisions to the orchestrator, and creates attention items for actions needing approval:

```javascript
// From autonomous-agent.js (now a sub-task)
const result = await agent.runAutonomousCycle()

if (result) {
  const actionsExecuted = result.executed?.length || 0
  const actionsQueued = result.queued?.length || 0

  await orchestrator.logAction({
    actor: ACTOR,
    actionType: 'cycle_complete',
    description: `Autonomous cycle: ${actionsExecuted} executed, ${actionsQueued} queued`,
    userVisible: actionsQueued > 0,
  })
}

// Notify user about pending approvals
const pending = await agent.getPendingApprovals()
if (pending.length > 0) {
  await orchestrator.createAttentionItem({
    domain: 'task',
    itemType: 'pending_approval',
    title: `${pending.length} autonomous action(s) need approval`,
    priority: 2,
    urgency: 'normal',
  })
}
```

### Context Sync as Pre-Condition

Context sync runs first because it updates behavioral overrides (like focus mode) that other sub-tasks check. If the user is in a meeting, the context sync sets `skipBriefing`, causing the stuck task detector and other notification-producing sub-tasks to skip:

```javascript
// context-sync.js sub-task
const currentEvents = await getEvents(windowStart, windowEnd)
for (const event of currentEvents) {
  const result = matchEventToBehaviors(event.title)
  if (result) Object.assign(mergedBehaviors, result.behaviors)
}
contextBehaviors.setAutoBehaviors(mergedBehaviors)

// Later sub-tasks check this:
const focusStatus = await focus.getStatus()
if (focusStatus.inFocus) {
  audit.log('stuck-task-detector:skipped', { reason: 'focus_mode' })
  return
}
```

## Implications

- Consolidation reduces 8 cron entries to 1, making the system's proactive behavior easier to reason about and debug
- Shared work-hour gating fixes the bug where context-sync and context-prefetch ran outside work hours in the standalone configuration
- Ordered sub-task execution (context sync before dispatch) creates implicit data dependencies -- behavioral state is fresh before decisions are made
- The old job files remain with `enabled: false` rather than being deleted, preserving their logic as documentation and allowing easy re-enablement for debugging
- Sub-task frequency control (every cycle vs. every 6th cycle) means some tasks run less often than their original standalone schedule. Stuck task detection dropping from every 2 hours to approximately every 2 hours (6 x 20 min) is close enough; context prefetch remaining separate at 5-minute intervals is a pragmatic exception
- A single consolidated job is a single point of failure -- if it crashes, all proactive intelligence stops. The standalone model was more resilient to individual failures
- Budget checking across all sub-tasks (not just dispatch) prevents the autonomous thinking cycle from queuing expensive actions when the budget is tight
- The consolidation pattern is a general principle: when you have N jobs with overlapping concerns and shared guards, consolidate them into a semantic group with ordered execution

## Code Example

```javascript
// Old world: 8 independent cron registrations
jobs.register('autonomous-agent',     '*/30 9-18 * * 1-5', autonomousAgent.run)
jobs.register('worker-dispatch',      '*/20 9-18 * * 1-5', workerDispatch.run)
jobs.register('context-sync',         '*/15 * * * *',       contextSync.run)
jobs.register('context-prefetch',     '*/5 * * * *',        contextPrefetch.run)
jobs.register('stuck-task-detector',  '0 */2 9-21 * * *',   stuckTasks.run)
jobs.register('stale-prs',           '...',                  stalePrs.run)
jobs.register('issue-solver',        '...',                  issueSolver.run)
jobs.register('action-inbox-refresh', '*/15 * * * *',       actionInbox.run)

// New world: single consolidated job
jobs.register('proactive-intelligence', '*/20 9-18 * * 1-5', async () => {
  await contextSync.run()
  await actionInbox.run()
  await workerDispatch.run()

  if (shouldRunThisCycle('autonomous-agent', 2))  await autonomousAgent.run()
  if (shouldRunThisCycle('stuck-tasks', 6))        await stuckTasks.run()
  if (shouldRunThisCycle('stale-prs', 6))          await stalePrs.run()
})
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Budget-Aware Task Execution](./budget-aware-task-execution.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Situation Detection and Context Awareness](./situation-detection-and-context-awareness.md)
