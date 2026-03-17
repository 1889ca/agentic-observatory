# Intent-Driven Self-Scheduling

> Agents create and manage their own scheduled tasks via API, with cron-based dispatch through a priority kanban queue rather than direct satellite execution.

## Problem

Traditional scheduling for AI agents uses fixed cron jobs defined by humans. The agent can't say "check on this deployment in 30 minutes" or "run a code review every morning at 9am." Without self-scheduling, every new recurring task requires a human to configure it, and ad-hoc future work gets lost.

## Context

- An orchestrator that needs to perform work at self-determined times, not just in response to external triggers
- Situations where the agent discovers during one task that future attention is needed
- Systems where scheduling requirements change dynamically based on what the agent learns
- Multiple worker models with different cost profiles
- Tasks need to flow through the same priority system as all other work

## Solution

### API-Based Task Management

The orchestrator exposes REST endpoints as part of its own HTTP API for creating, listing, triggering, and deleting scheduled tasks. These endpoints are called by agents running within the orchestrator context (e.g., satellites executing tasks), not as a standalone external service:

```javascript
// routes.js
'POST /api/tasks': async (req, res) => {
  const body = await parseBody(req);
  if (!body.id || !body.schedule || !body.prompt) {
    return json(res, { error: 'id, schedule, and prompt required' }, 400);
  }
  json(res, createTask(body.id, body.schedule, body.prompt, body));
},

'GET /api/tasks': async (req, res) => {
  json(res, listTasks());
},

'POST /api/tasks/:id/run': async (req, res) => {
  const result = await runTaskNow(req.params.id);
  json(res, result);
},
```

### Cron-Based Dispatch

Tasks are registered with `node-cron` for time-based triggering. When a task fires, it enqueues work into the kanban queue rather than dispatching directly to a satellite:

```javascript
// tasks.js
function createTask(id, schedule, prompt, opts = {}) {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  tasksDb.add(id, schedule, prompt, opts);
  const task = tasksDb.get(id);
  registerJob(task);
  return task;
}

function registerJob(task) {
  if (activeCrons.has(task.id)) {
    activeCrons.get(task.id).stop();
  }

  const job = cron.schedule(task.schedule, async () => {
    // Enqueue to kanban — NOT direct satellite dispatch
    dispatch({
      lane: 'task',
      description: `Scheduled: ${task.id}`,
      prompt: task.prompt,
      scheduled_task_id: task.id,
      result_handler: 'task',
    });
  });

  activeCrons.set(task.id, job);
}
```

### Kanban Integration

Scheduled tasks flow through the same kanban priority queue as all other work. This means they respect concurrency limits, per-project locks, and priority ordering:

```
Cron fires → dispatch({ lane: 'task' }) → kanban queue → satellite worker
```

The `result_handler: 'task'` field routes completion results back to the task system for logging and error handling.

### Dynamic Self-Scheduling During Execution

Agents running as orchestrator satellites can create follow-up tasks during their own execution by calling back to the orchestrator's API. A morning review task might discover a failing build and schedule a follow-up check:

```javascript
// Agent creates a follow-up task via REST API
await fetch('http://localhost:3847/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'followup-build-check',
    schedule: '30 10 * * *',  // check at 10:30am
    prompt: 'The billing-api build failed at 9am. Check if the fix PR was merged.',
    model: 'haiku',
    workdir: '/projects/billing-api',
  }),
});

// Once the follow-up is resolved, the agent deletes the task
await fetch('http://localhost:3847/api/tasks/followup-build-check', {
  method: 'DELETE',
});
```

### Model Selection for Cost Control

Different tasks warrant different model capabilities:

- **haiku**: Health checks, status polls, simple verifications
- **sonnet**: Code reviews, planning, multi-step reasoning (default)
- **opus**: Architecture decisions, complex debugging (used sparingly)

## Implications

- Tasks enqueue to kanban rather than dispatching directly, so they respect the same concurrency limits and priority ordering as all other work
- Cron expressions provide minute-level granularity but not sub-minute precision
- Tasks persist in the database, surviving orchestrator restarts. The cron scheduler re-registers all enabled tasks on startup
- Self-scheduled tasks are indistinguishable from human-created ones — the same orchestrator API serves both
- One-shot tasks require the agent to clean up after itself by calling `DELETE /api/tasks/:id`

## Code Example

```javascript
// Complete lifecycle: create, fire, execute, clean up

// 1. Human or agent creates a recurring task via the orchestrator's API
await fetch('http://localhost:3847/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'daily-dependency-check',
    schedule: '0 14 * * 1-5',  // 2pm on weekdays
    prompt: 'Check all projects for outdated dependencies. Open PRs for critical updates.',
    model: 'sonnet',
  }),
});

// 2. At 2pm on Monday, cron fires → task enqueues to kanban
// dispatch({ lane: 'task', prompt: '...', scheduled_task_id: 'daily-dependency-check' })

// 3. Kanban worker picks it up when a satellite slot is available
// sendRun({ prompt, model, cwd }) → satellite executes

// 4. Result routes back via result_handler: 'task'
// Task system logs completion, tracks success/failure

// 5. If the agent discovers a one-time follow-up during execution:
await fetch('http://localhost:3847/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: `followup-${Date.now()}`,
    schedule: '*/30 * * * *',
    prompt: 'Check if PR #142 was reviewed. If approved, merge and delete this task.',
    model: 'haiku',
  }),
});
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
