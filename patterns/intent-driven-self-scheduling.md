# Intent-Driven Self-Scheduling

> Cron-based task scheduling via the unified trigger system, dispatching work through the worker API for prioritized execution.

## Problem

Traditional scheduling for AI agents uses fixed cron jobs defined by humans. The agent can't say "check on this deployment in 30 minutes" or "run a code review every morning at 9am." Without self-scheduling, every new recurring task requires a human to configure it, and ad-hoc future work gets lost.

## Context

- An orchestrator that needs to perform work at self-determined times, not just in response to external triggers
- Situations where the agent discovers during one task that future attention is needed
- Systems where scheduling requirements change dynamically based on what the agent learns
- Multiple worker models with different cost profiles
- A unified dispatch endpoint that handles both immediate and scheduled work

## Solution

### Cron Triggers Dispatching to Workers

Scheduled tasks are defined with cron expressions and persisted in the database. When a cron trigger fires, it dispatches work through the worker API rather than executing directly. The trigger system handles the scheduling concern; the worker system handles execution:

```javascript
// routes.js (illustrative)
'POST /api/workers/:workerType/dispatch': async (req, res) => {
  const { workerType } = req.params;
  const body = await parseBody(req);

  const task = await dispatchToWorker(workerType, {
    prompt: body.prompt,
    model: body.model || 'sonnet',
    workdir: body.workdir,
    priority: body.priority || 'normal',
    metadata: body.metadata,
  });

  json(res, task);
},
```

This is the entry point for dispatching work. Cron triggers call into this same endpoint, meaning scheduled work follows the same path as manually triggered work.

### Schedule Registration and Persistence

Schedules are registered with `node-cron` for timing and persisted to the database so they survive restarts. On startup, all enabled schedules are re-registered:

```javascript
// lib/scheduler.js (illustrative)
function registerSchedule(id, schedule, config) {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  // Persist to DB so schedules survive restarts
  schedulesDb.upsert(id, { schedule, ...config });

  const job = cron.schedule(schedule, async () => {
    // Fire into the dispatch system — NOT direct execution
    await dispatchToWorker(config.workerType || 'local', {
      prompt: config.prompt,
      model: config.model || 'sonnet',
      workdir: config.workdir,
      priority: config.priority || 'normal',
      metadata: { scheduled_task_id: id },
    });
  });

  activeJobs.set(id, job);
}

// On startup, re-register all persisted schedules
async function restoreSchedules() {
  const schedules = await schedulesDb.getAll({ enabled: true });
  for (const s of schedules) {
    registerSchedule(s.id, s.schedule, s);
  }
}
```

### Worker API Integration

Scheduled work enters the worker dispatch system where it is queued alongside manually triggered and agent-initiated work. This means scheduled tasks respect concurrency limits, per-project locks, and priority ordering:

```
Cron fires → dispatchToWorker() → worker queue (prioritized) → dispatcher spawns worker process
```

There is no fast path that bypasses the queue. A low-priority scheduled task will wait behind high-priority manual work, which prevents scheduled maintenance from starving urgent fixes.

### Agent-Initiated Follow-Up Work

Agents running as workers can dispatch follow-up work during their own execution by calling back to the orchestrator's dispatch endpoint. A morning review task might discover a failing build and dispatch immediate follow-up:

```javascript
// During agent execution — agent dispatches immediate follow-up work
await fetch('http://localhost:3847/api/workers/local/dispatch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'The billing-api build failed. Check if the fix PR was merged and the build is green.',
    model: 'haiku',
    workdir: '/projects/billing-api',
    priority: 'high',
  }),
});
```

### Model Selection for Cost Control

Different tasks warrant different model capabilities. The dispatch endpoint accepts a model parameter that the dispatcher passes through to the spawned worker process:

- **haiku**: Health checks, status polls, simple verifications
- **sonnet**: Code reviews, planning, multi-step reasoning (default)
- **opus**: Architecture decisions, complex debugging (used sparingly)

Cost-conscious scheduling means routine daily checks use haiku, while weekly deep reviews use sonnet or opus.

## Implications

- All work — scheduled, manual, and agent-initiated — flows through the same dispatch endpoint, making the system's workload fully observable from a single point
- Cron expressions provide minute-level granularity but not sub-minute precision
- Schedules persist in the database, surviving orchestrator restarts. The scheduler re-registers all enabled schedules on startup
- Dispatched work from agents is indistinguishable from human-triggered work once it enters the queue — the same priority and concurrency rules apply
- The worker type parameter in the dispatch endpoint allows routing to different backends (local CC, GitHub CC) without changing the caller's interface

## Code Example

```javascript
// Complete lifecycle: schedule registered, cron fires, work dispatched, agent dispatches follow-up

// 1. On startup, the orchestrator registers persistent schedules
registerSchedule('daily-dependency-check', '0 14 * * 1-5', {
  prompt: 'Check all projects for outdated dependencies. Open PRs for critical updates.',
  model: 'sonnet',
  workerType: 'local',
  priority: 'normal',
});

// 2. At 2pm on Monday, cron fires → dispatches to worker system
// dispatchToWorker('local', { prompt: '...', model: 'sonnet', metadata: { scheduled_task_id: 'daily-dependency-check' } })

// 3. Worker queue orders it among other pending work
// queue: [urgent-fix (high), daily-dependency-check (normal), cleanup-logs (low)]

// 4. Dispatcher spawns a worker process when a slot opens
// claude --prompt "Check all projects for outdated dependencies..." --model sonnet

// 5. During execution, the agent discovers a critical update and dispatches immediate follow-up
await fetch('http://localhost:3847/api/workers/local/dispatch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Critical: express 4.x has a security vulnerability. Upgrade to 5.x in billing-api and open a PR.',
    model: 'sonnet',
    workdir: '/projects/billing-api',
    priority: 'high',
  }),
});

// 6. The follow-up enters the worker queue at high priority and is dispatched next
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
