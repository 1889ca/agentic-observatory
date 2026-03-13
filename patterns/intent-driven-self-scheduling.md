# Intent-Driven Self-Scheduling

> An agent schedules its own future wake-ups via API rather than relying on external polling or fixed intervals.

## Problem

Traditional scheduling for AI agents uses fixed cron jobs defined by humans — the agent runs at predetermined times whether or not there's anything to do. This gives the agent no agency over its own attention rhythm. The agent can't say "check on this deployment in 30 minutes" or "run a code review every morning at 9am." Without self-scheduling, every new recurring task requires a human to configure it, and ad-hoc future work gets lost.

## Context

- An orchestrator that needs to perform work at self-determined times, not just in response to external triggers
- Situations where the agent discovers during one task that future attention is needed
- Systems where scheduling requirements change dynamically based on what the agent learns
- Multiple worker models with different cost profiles (use cheap models for routine checks, expensive ones for deep analysis)

## Solution

### API-Based Task Registration

The agent creates, modifies, and deletes its own scheduled tasks through the orchestrator's API. Each task is a database record with a cron expression, a prompt, model selection, and a working directory:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,        -- cron expression: '0 9 * * *'
  prompt TEXT NOT NULL,          -- what the agent should do when triggered
  model TEXT DEFAULT 'haiku',    -- which model to use
  workdir TEXT,                  -- working directory for the task
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Task CRUD via REST API

The orchestrator exposes endpoints that agents (or humans) use to manage scheduled tasks:

```javascript
// Create a new scheduled task
// POST /api/tasks
{
  "id": "morning-review",
  "schedule": "0 9 * * *",
  "prompt": "Review overnight activity. Check for failed builds, stale PRs, and unresolved alerts.",
  "model": "sonnet",
  "workdir": "/projects/main-api"
}

// List all tasks
// GET /api/tasks

// Trigger a task immediately (outside its schedule)
// POST /api/tasks/:id/run

// Update or delete tasks
// PUT /api/tasks/:id
// DELETE /api/tasks/:id
```

### Cron-Based Dispatch

The orchestrator runs a cron scheduler (e.g., `node-cron`) that evaluates task schedules every minute and dispatches due tasks to workers:

```javascript
import cron from 'node-cron';

// On startup, register all enabled tasks with the cron scheduler
const activeCrons = new Map();

function registerTask(task) {
  if (activeCrons.has(task.id)) {
    activeCrons.get(task.id).stop();
  }

  const job = cron.schedule(task.schedule, async () => {
    await dispatchToWorker({
      prompt: task.prompt,
      model: task.model,
      workdir: task.workdir,
    });
  });

  activeCrons.set(task.id, job);
}

// When tasks are created/updated via API, re-register them
async function handleTaskCreate(task) {
  await db.query(
    `INSERT INTO tasks (id, schedule, prompt, model, workdir)
     VALUES ($1, $2, $3, $4, $5)`,
    [task.id, task.schedule, task.prompt, task.model, task.workdir]
  );
  registerTask(task);
}
```

### Dynamic Self-Scheduling During Execution

The key pattern: agents create new tasks during their own execution. A morning review task might discover a failing build and schedule a follow-up check:

```javascript
// During a flow step, the agent calls the orchestrator API
await fetch('http://localhost:3847/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'followup-build-check',
    schedule: '30 10 * * *',  // check at 10:30am
    prompt: 'The billing-api build failed at 9am. Check if the fix PR was merged and the build is green now.',
    model: 'haiku',
    workdir: '/projects/billing-api',
  }),
});
```

Once the follow-up is no longer needed, the agent (or a subsequent task) deletes it.

### Model Selection for Cost Control

Different tasks warrant different model capabilities. Routine checks use cheap, fast models; deeper analysis uses more capable ones:

- **haiku**: Health checks, status polls, simple verifications
- **sonnet**: Code reviews, planning, multi-step reasoning
- **opus**: Architecture decisions, complex debugging (used sparingly)

## Implications

- Agents can create tasks without limit — a runaway agent could schedule hundreds of tasks. Rate limiting or caps on task creation are advisable
- Cron expressions provide minute-level granularity but not sub-minute precision
- Tasks persist in the database, surviving orchestrator restarts. The cron scheduler re-registers all enabled tasks on startup
- Self-scheduled tasks are indistinguishable from human-created ones — the same API serves both
- One-shot tasks (run once then delete) require the agent to clean up after itself, or the orchestrator to support a `run_once` flag
- Tasks are prompts, not actions — the agent still reasons about what to do when the task fires

## Code Example

```javascript
// Reference implementation: Riley orchestrator (node-cron + PostgreSQL)

// Agent creates a recurring daily review
await createTask({
  id: 'daily-dependency-check',
  schedule: '0 14 * * 1-5',  // 2pm on weekdays
  prompt: 'Check all projects for outdated dependencies. If any are more than 2 minor versions behind, open a PR to update them.',
  model: 'sonnet',
});

// Agent creates a one-time follow-up during execution
await createTask({
  id: `followup-${Date.now()}`,
  schedule: '*/30 * * * *',  // every 30 minutes
  prompt: 'Check if PR #142 has been reviewed. If approved, merge it. Then delete this task.',
  model: 'haiku',
  workdir: '/projects/auth-service',
});
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Inner Monologue and Reflection](./inner-monologue-and-reflection.md)
