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
- Tasks should be manageable programmatically: created, updated, toggled, listed, and triggered on demand

## Solution

### Task Storage

Tasks are stored in PostgreSQL with a consistent schema:

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

Storing task definitions in PostgreSQL rather than configuration files keeps task management centralized and auditable. Tasks can be created, updated, listed, toggled (enabled/disabled), and manually triggered through the orchestrator's task management layer — the exact API surface varies by implementation, but the lifecycle operations are consistent.

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

### Task Lifecycle

The orchestrator exposes task management operations that cover the full lifecycle:

- **Create/update:** Register a new task or modify an existing one (schedule, prompt, model, workdir, enabled status)
- **List:** Inspect all registered tasks and their current state
- **Toggle:** Pause or resume a task by flipping its `enabled` field without deleting the definition
- **Manual trigger:** Execute a task immediately outside its normal schedule (still subject to the concurrent execution guard)

These operations are typically exposed via the orchestrator's API, but the key architectural point is that task definitions live in the database and are managed centrally — not scattered across project config files.

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
// Register a maintenance task through the orchestrator's task management
const task = {
  id: 'nightly-test-suite',
  schedule: '0 3 * * *',       // Daily at 3 AM
  prompt: `Run the full test suite. Report any failures with
           file paths and error messages. Do NOT attempt fixes.`,
  model: 'sonnet',
  workdir: '/srv/my-project',
  enabled: true
};

await taskManager.create(task);

// Manually trigger a task outside its schedule
await taskManager.trigger('nightly-test-suite');

// Pause a task without deleting it
await taskManager.update('nightly-test-suite', { enabled: false });
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
