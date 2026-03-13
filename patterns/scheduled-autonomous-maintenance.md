# Scheduled Autonomous Maintenance

> Cron-based task scheduling for agent-managed projects with concurrent execution guards and centralized result processing.

## Problem

Software projects need ongoing maintenance — dependency audits, test runs, documentation freshness checks, code quality sweeps. Doing this manually is tedious and gets forgotten. But fully autonomous maintenance is risky without structure: an agent needs clear task definitions, execution guardrails, and a way to report results back to the orchestrator. You need a scheduling system that treats maintenance tasks as first-class entities with defined cadences, execution constraints, and result routing.

## Context

- Multiple projects managed by a central orchestrator
- Each project has different maintenance needs and cadences
- Tasks vary in complexity and model requirements (lightweight checks vs. deep analysis)
- Some tasks take minutes, others take much longer — overlapping runs must be prevented
- The orchestrator needs visibility into task results without polling individual projects
- Tasks should be manageable via API for programmatic creation, updates, and manual triggers

## Solution

### Task Storage

Tasks are stored in a database (e.g., PostgreSQL) with a consistent schema:

```javascript
// Task record
{
  id: 'weekly-dep-audit',       // Unique identifier
  schedule: '0 9 * * 1',        // Standard cron expression
  prompt: 'Audit dependencies for security vulnerabilities...',
  model: 'sonnet',              // Which model to dispatch to
  workdir: '/path/to/project',  // Execution context
  enabled: true                 // Can be toggled without deletion
}
```

### Cron-Based Scheduling with Concurrent Execution Guards

The scheduler uses `node-cron` to trigger tasks at their defined cadences. A running set prevents overlapping executions of the same task:

```javascript
const running = new Set();

cron.schedule(task.schedule, async () => {
  if (running.has(task.id)) return;  // Skip if already running
  running.add(task.id);
  try {
    const result = await dispatch(task);
    enqueue({ type: 'task-result', task: task.id, result });
  } finally {
    running.delete(task.id);
  }
});
```

If a task is still running when its next scheduled slot arrives, that slot is silently skipped. No queuing, no retry — the next natural slot will attempt execution again.

### API-Driven Task Management

Tasks are managed through the orchestrator's API rather than configuration files:

- **Create/update:** `POST /api/tasks` with the task definition
- **Manual trigger:** `POST /api/tasks/:id/run` to execute immediately (still subject to the concurrent execution guard)
- **List:** `GET /api/tasks` to inspect all registered tasks
- **Toggle:** Update the `enabled` field to pause/resume without deleting the task definition

This keeps task management centralized and auditable — no scattered config files across projects.

### Result Processing

All task results flow back through the orchestrator's message queue:

- Results are enqueued with appropriate priority (above ambient activity, below urgent user requests)
- The orchestrator can act on results: relay to the user, trigger follow-up work, or log and move on
- Failed tasks log errors but do not block other scheduled work
- No automatic retry — failed tasks wait for their next scheduled slot

## Implications

- Cron scheduling is time-based only — no event-driven triggers (e.g., "run when a PR is opened")
- The concurrent execution guard means long-running tasks can miss their next scheduled slot, which is by design but requires tasks to be scoped appropriately
- No dependency ordering between tasks — if task A must complete before task B, that ordering must be encoded in the prompts or handled at a higher level
- Heavy scheduling can consume agent dispatch capacity, starving on-demand work
- The `enabled` toggle provides a safe way to pause maintenance without losing task definitions
- Task prompts carry the full instruction set — the scheduling system is prompt-agnostic and does not interpret task content

## Code Example

```javascript
// Register a maintenance task
await fetch('http://orchestrator/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'nightly-test-suite',
    schedule: '0 3 * * *',       // Daily at 3 AM
    prompt: `Run the full test suite. Report any failures with
             file paths and error messages. Do NOT attempt fixes.`,
    model: 'sonnet',
    workdir: '/srv/my-project',
    enabled: true
  })
});

// Manually trigger a task outside its schedule
await fetch('http://orchestrator/api/tasks/nightly-test-suite/run', {
  method: 'POST'
});
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
