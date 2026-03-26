# Scheduled Autonomous Maintenance

> Worker task pipelines with multi-step execution, template interpolation, and built-in maintenance pipelines for automated project upkeep.

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

### Worker Task Pipeline

Rather than a simple dequeue/claim model, the scheduler uses a multi-step pipeline architecture. Pipelines are stored in `worker_task_pipelines` and their executions in `worker_task_pipeline_executions`:

```sql
-- worker_task_pipelines
id SERIAL PRIMARY KEY,
name TEXT,
description TEXT,
steps JSON  -- Array of step definitions

-- worker_task_pipeline_executions
id SERIAL PRIMARY KEY,
pipeline_id INTEGER REFERENCES worker_task_pipelines(id),
document_id INTEGER,  -- FK, nullable
status TEXT,          -- running | completed | failed | cancelled
current_step_index INTEGER,
step_history JSON,
context JSON,
started_at TIMESTAMP,
completed_at TIMESTAMP,
error TEXT
```

Each step in a pipeline defines a worker task type and parameters, with template interpolation for dynamic values:

```javascript
// Step definition
{ type: 'workerTask', name: 'run tests', taskType: 'coding', params: { description: '{{context.prompt}}' } }

// Execution flow
async function startPipeline(pipelineId, documentId, context) {
  const execution = await createExecution(pipelineId, documentId, context);
  await executeNextStep(execution);
}

async function executeNextStep(execution) {
  const step = execution.steps[execution.current_step_index];
  const resolved = resolveTemplate(step.params, execution.context);  // {{field}} and {{field.nested}}
  const task = await createWorkerTask(resolved);
  await dispatch(task);
  // On completion: handleTaskComplete() advances to next step
  // On failure: failExecution()
  // On all steps complete: completeExecution()
}
```

Built-in pipelines like `code-review-merge` and `code-test-review` chain multiple worker tasks into a single orchestrated workflow. If a step fails, the entire execution is marked as failed — no partial retry.

### Task Lifecycle

The orchestrator exposes task management operations that cover the full lifecycle:

- **Create/update:** Register a new task or modify an existing one (schedule, prompt, model, workdir, enabled status)
- **List:** Inspect all registered tasks and their current state
- **Toggle:** Pause or resume a task by flipping its `enabled` field without deleting the definition
- **Manual trigger:** Execute a task immediately outside its normal schedule

These operations are typically exposed via the orchestrator's API, but the key architectural point is that task definitions live in the database and are managed centrally — not scattered across project config files.

### Result Processing

All task results flow back through the orchestrator's message queue:

- Results are enqueued with appropriate priority (above ambient activity, below urgent user requests)
- The orchestrator can act on results: relay to the user, trigger follow-up work, or log and move on
- Failed tasks log errors but do not block other scheduled work
- No automatic retry — failed tasks wait for their next scheduled slot

## Implications

- The schedule check is time-based only — no event-driven triggers (e.g., "run when a PR is opened")
- Pipelines execute steps sequentially — if a step fails, the entire execution is marked failed with no partial retry
- No dependency ordering between independent pipelines — if pipeline A must complete before pipeline B, that ordering must be encoded at a higher level
- Heavy scheduling can consume agent dispatch capacity, starving on-demand work
- The `enabled` toggle provides a safe way to pause maintenance without losing task definitions
- Task prompts carry the full instruction set — the scheduling system is prompt-agnostic and does not interpret task content

## Code Example

```javascript
// Register a maintenance task through the orchestrator's task management
const task = {
  id: 'nightly-test-suite',
  schedule: '0 3 * * *',
  prompt: `Run the full test suite. Report any failures with
           file paths and error messages. Do NOT attempt fixes.`,
  model: 'sonnet',
  workdir: '/srv/my-project',
  enabled: true
};

await taskManager.create(task);

// Start a multi-step pipeline execution
await startPipeline(pipelineId, documentId, {
  prompt: 'Review and test the latest changes',
  repo: '/srv/my-project'
});
// → Creates execution, resolves {{context.prompt}} in each step,
//   dispatches worker tasks sequentially, advances on completion

// Manually trigger a task outside its schedule
await taskManager.trigger('nightly-test-suite');

// Pause a task without deleting it
await taskManager.update('nightly-test-suite', { enabled: false });
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
