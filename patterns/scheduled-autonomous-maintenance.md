# Scheduled Autonomous Maintenance

> Kanban-style task queue for agent-managed projects with claim-based locking and centralized result processing.

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

### Kanban Queue with Claim-Based Locking

Rather than dispatching tasks directly via `node-cron`, the scheduler uses a kanban dequeue/claim model. Tasks whose schedule has elapsed are enqueued into a priority queue in `task-queue.js`. A processor loop calls `dequeueNext()` to claim the highest-priority ready task. Claiming a task locks it, preventing duplicate execution:

```javascript
// task-queue.js
async function enqueueReady() {
  const tasks = await getEnabledTasks();
  for (const task of tasks) {
    if (isDue(task) && !isClaimed(task)) {
      await enqueue(task);
    }
  }
}

async function dequeueNext() {
  // Atomically claim the highest-priority unclaimed task
  const task = await claimNext();
  if (!task) return null;

  try {
    const result = await dispatch(task);
    await recordResult({ type: 'task-result', task: task.id, result });
  } finally {
    await releaseClaim(task.id);
  }

  return task;
}
```

If a task is already claimed when its next scheduled slot arrives, it is not re-enqueued. No queuing of duplicates, no retry — the next evaluation cycle will enqueue it again once the claim is released.

### Task Lifecycle

The orchestrator exposes task management operations that cover the full lifecycle:

- **Create/update:** Register a new task or modify an existing one (schedule, prompt, model, workdir, enabled status)
- **List:** Inspect all registered tasks and their current state
- **Toggle:** Pause or resume a task by flipping its `enabled` field without deleting the definition
- **Manual trigger:** Execute a task immediately outside its normal schedule (still subject to claim-based locking)

These operations are typically exposed via the orchestrator's API, but the key architectural point is that task definitions live in the database and are managed centrally — not scattered across project config files.

### Result Processing

All task results flow back through the orchestrator's message queue:

- Results are enqueued with appropriate priority (above ambient activity, below urgent user requests)
- The orchestrator can act on results: relay to the user, trigger follow-up work, or log and move on
- Failed tasks log errors but do not block other scheduled work
- No automatic retry — failed tasks wait for their next scheduled slot

## Implications

- The schedule check is time-based only — no event-driven triggers (e.g., "run when a PR is opened")
- Claim-based locking means long-running tasks will not be re-enqueued until their claim is released, which is by design but requires tasks to be scoped appropriately
- No dependency ordering between tasks — if task A must complete before task B, that ordering must be encoded in the prompts or handled at a higher level
- Heavy scheduling can consume agent dispatch capacity, starving on-demand work
- The `enabled` toggle provides a safe way to pause maintenance without losing task definitions
- Task prompts carry the full instruction set — the scheduling system is prompt-agnostic and does not interpret task content

## Code Example

```javascript
// Register a maintenance task through the orchestrator's task management
const task = {
  id: 'nightly-test-suite',
  schedule: '0 3 * * *',       // Cron expression defines when the task becomes due
  prompt: `Run the full test suite. Report any failures with
           file paths and error messages. Do NOT attempt fixes.`,
  model: 'sonnet',
  workdir: '/srv/my-project',
  enabled: true
};

await taskManager.create(task);

// The queue processor claims and executes due tasks
const claimed = await dequeueNext();
// → { id: 'nightly-test-suite', ... } if due and unclaimed

// Manually trigger a task outside its schedule (enqueues immediately)
await taskManager.trigger('nightly-test-suite');

// Pause a task without deleting it
await taskManager.update('nightly-test-suite', { enabled: false });
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
