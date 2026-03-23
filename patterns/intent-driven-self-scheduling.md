# Intent-Driven Self-Scheduling

> Agents dispatch their own work and schedule future tasks via the worker dispatch system, with cron-based triggers flowing through the same priority kanban queue as all other work.

## Problem

Traditional scheduling for AI agents uses fixed cron jobs defined by humans. The agent can't say "check on this deployment in 30 minutes" or "run a code review every morning at 9am." Without self-scheduling, every new recurring task requires a human to configure it, and ad-hoc future work gets lost.

## Context

- An orchestrator that needs to perform work at self-determined times, not just in response to external triggers
- Situations where the agent discovers during one task that future attention is needed
- Systems where scheduling requirements change dynamically based on what the agent learns
- Multiple worker models with different cost profiles
- Tasks need to flow through the same priority system as all other work
- A unified dispatch endpoint that handles both immediate and scheduled work

## Solution

### Worker-Type Dispatch Endpoint

Work is dispatched through a single endpoint scoped by worker type. The worker type determines which execution backend handles the task — local Claude Code, GitHub CC, or other backends:

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

This is the only entry point for dispatching work. There is no separate task CRUD API — tasks are created by dispatching them, and the dispatch system handles queuing, persistence, and execution.

### Cron-Based Scheduling into the Dispatch System

Scheduled tasks are registered with `node-cron`, but when a cron fires, it dispatches through the worker system rather than executing directly. This means scheduled work flows through the same priority kanban queue as everything else:

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

### Kanban Integration

Scheduled tasks enter the same kanban priority queue as manually triggered and agent-initiated work. This means they respect concurrency limits, per-project locks, and priority ordering:

```
Cron fires → dispatchToWorker() → kanban queue (prioritized) → dispatcher spawns CC process
```

There is no fast path that bypasses the queue. A low-priority scheduled task will wait behind high-priority manual work, which prevents scheduled maintenance from starving urgent fixes.

### Self-Scheduling During Execution

Agents running as Claude Code satellites can dispatch follow-up work during their own execution by calling back to the orchestrator's dispatch endpoint. A morning review task might discover a failing build and schedule a follow-up check:

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

For recurring self-scheduled work, the agent can register a cron schedule through the orchestrator's internal API or by including scheduling instructions in its output that the result handler interprets.

### Model Selection for Cost Control

Different tasks warrant different model capabilities. The dispatch endpoint accepts a model parameter that the dispatcher passes through to the spawned CC process:

- **haiku**: Health checks, status polls, simple verifications
- **sonnet**: Code reviews, planning, multi-step reasoning (default)
- **opus**: Architecture decisions, complex debugging (used sparingly)

Cost-conscious scheduling means routine daily checks use haiku, while weekly deep reviews use sonnet or opus.

## Implications

- All work — scheduled, manual, and agent-initiated — flows through the same dispatch endpoint and kanban queue, making the system's workload fully observable from a single point
- Cron expressions provide minute-level granularity but not sub-minute precision
- Schedules persist in the database, surviving orchestrator restarts. The scheduler re-registers all enabled schedules on startup
- Self-dispatched work is indistinguishable from human-triggered work once it enters the queue — the same priority and concurrency rules apply
- The worker type parameter in the dispatch endpoint allows routing to different backends (local CC, GitHub CC) without changing the caller's interface
- There is no separate task management API to maintain — the dispatch endpoint is the single interface for all work creation

## Code Example

```javascript
// Complete lifecycle: schedule registered, cron fires, work dispatched, agent self-schedules follow-up

// 1. On startup, the orchestrator registers persistent schedules
registerSchedule('daily-dependency-check', '0 14 * * 1-5', {
  prompt: 'Check all projects for outdated dependencies. Open PRs for critical updates.',
  model: 'sonnet',
  workerType: 'local',
  priority: 'normal',
});

// 2. At 2pm on Monday, cron fires → dispatches to worker system
// dispatchToWorker('local', { prompt: '...', model: 'sonnet', metadata: { scheduled_task_id: 'daily-dependency-check' } })

// 3. Kanban queue orders it among other pending work
// queue: [urgent-fix (high), daily-dependency-check (normal), cleanup-logs (low)]

// 4. Dispatcher spawns a CC process when a slot opens
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

// 6. The follow-up enters the kanban queue at high priority and is dispatched next
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
