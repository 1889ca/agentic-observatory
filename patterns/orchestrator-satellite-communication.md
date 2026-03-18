# Orchestrator-Worker Communication

> Database-backed task pipeline with typed runners for orchestrator-to-worker job dispatch, state tracking via worker_tasks and worker_history tables, and result synchronization back to source documents.

## Problem

An orchestrator needs to dispatch heterogeneous work (code generation, issue solving, maintenance tasks) to AI agent workers, track execution through multiple terminal states, and synchronize results back to the originating documents. Simple "pending/running/done" state machines miss real-world outcomes like PR creation or task abandonment. Without execution history per document, there's no way to answer "how many times has this document been worked on, and what happened each time?"

## Context

- A central orchestrator dispatching work to typed runner functions (claude-executor, solve-issue, coding, etc.)
- Multiple task types requiring different execution strategies but a unified dispatch pipeline
- Documents (issues, maintenance items, coding tasks) that need their state kept in sync with worker outcomes
- Need for execution history — not just current status, but a full audit trail per document
- Workers that can produce multiple outcome types: successful completion, failure, PR creation, or voluntary abandonment
- Isolated execution contexts via agent sessions to prevent cross-task contamination

## Solution

### Database Schema: worker_tasks and worker_history

Two tables form the backbone. `worker_tasks` tracks active dispatch state, while `worker_history` provides a per-document audit trail:

```sql
-- Active task dispatch
CREATE TABLE worker_tasks (
  id SERIAL PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  task_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, running, completed, failed, pr_created, abandoned
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Execution history per document
CREATE TABLE worker_history (
  id SERIAL PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  worker_task_id INTEGER REFERENCES worker_tasks(id),
  task_type VARCHAR(50),
  status VARCHAR(20),
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Isolated execution contexts
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  name VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Worker Status Values

Tasks move through a richer state machine than simple pass/fail:

```
QUEUED → RUNNING → COMPLETED
                 → FAILED
                 → PR_CREATED
                 → ABANDONED
```

`PR_CREATED` captures when a worker's output is a pull request rather than a direct result. `ABANDONED` handles cases where a worker determines the task isn't feasible and voluntarily stops.

### Task Dispatch Flow

The dispatch pipeline follows five phases, coordinated through `worker-execution.js`:

```javascript
// lib/worker-execution.js

// Phase 1: Task enters worker_tasks
async function dispatchTask(documentId, taskType, params) {
  const [task] = await db('worker_tasks').insert({
    document_id: documentId,
    task_type: taskType,
    status: 'pending',
  }).returning('*');

  // Phase 2: Initialize execution tracking
  await initWorkerExecution(documentId, {
    workerTaskId: task.id,
    taskType,
  });

  return task;
}

// Phase 2: Create worker_history entry linking document to task
async function initWorkerExecution(documentId, { workerTaskId, taskType }) {
  await db('worker_history').insert({
    document_id: documentId,
    worker_task_id: workerTaskId,
    task_type: taskType,
    status: 'pending',
  });
}

// Phase 3: Transition to RUNNING
async function markStarted(documentId) {
  const now = new Date();
  await db('worker_tasks')
    .where({ document_id: documentId, status: 'pending' })
    .update({ status: 'running', started_at: now });

  await db('worker_history')
    .where({ document_id: documentId, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first()
    .update({ status: 'running' });
}
```

### Progress Updates

Workers report brief status updates during execution without changing the task's state:

```javascript
// lib/worker-execution.js
async function updateProgress(documentId, message) {
  await db('worker_tasks')
    .where({ document_id: documentId, status: 'running' })
    .update({
      result: db.raw(`COALESCE(result, '{}'::jsonb) || ?::jsonb`, [
        JSON.stringify({ progress: message, updated_at: new Date().toISOString() })
      ]),
    });
}
```

### Completion and Result Sync

When a worker finishes, `markCompleted` writes the result and synchronizes it back to the source document:

```javascript
// lib/worker-execution.js

// Phase 5: Complete and sync result back to document
async function markCompleted(documentId, result) {
  const status = result.pr_url ? 'pr_created'
    : result.abandoned ? 'abandoned'
    : result.error ? 'failed'
    : 'completed';

  const now = new Date();

  await db('worker_tasks')
    .where({ document_id: documentId, status: 'running' })
    .update({ status, result, completed_at: now });

  await db('worker_history')
    .where({ document_id: documentId, status: 'running' })
    .orderBy('created_at', 'desc')
    .first()
    .update({ status, result, completed_at: now });

  // Sync result back to source document
  await db('documents')
    .where({ id: documentId })
    .update({
      worker_status: status,
      worker_result: result,
      updated_at: now,
    });
}
```

### Typed Runners

Each task type has a dedicated runner that knows how to execute that category of work:

```javascript
// worker/runners/claude-executor.js
async function run(task, session) { /* general Claude prompts */ }

// worker/runners/solve-issue.js
async function run(task, session) { /* GitHub issue resolution */ }

// worker/runners/coding.js
async function run(task, session) { /* code generation tasks */ }
```

The task runner selects the appropriate runner based on `task_type` and executes within an isolated agent session.

### Auto-Init for Direct Dispatch

When tasks arrive via `dispatch_to_worker` (bypassing the normal init flow), `syncFromWorkerTask` handles retroactive initialization:

```javascript
// lib/worker-execution.js
async function syncFromWorkerTask(workerTaskId) {
  const task = await db('worker_tasks').where({ id: workerTaskId }).first();
  if (!task) throw new Error(`Worker task ${workerTaskId} not found`);

  // Create history entry if one doesn't exist
  const existing = await db('worker_history')
    .where({ worker_task_id: workerTaskId })
    .first();

  if (!existing) {
    await initWorkerExecution(task.document_id, {
      workerTaskId: task.id,
      taskType: task.task_type,
    });
  }

  return task;
}
```

## Implications

- The six-value status enum (QUEUED, RUNNING, COMPLETED, FAILED, PR_CREATED, ABANDONED) captures real-world outcomes that binary pass/fail misses — a PR creation is a success but requires different downstream handling than a direct completion
- `worker_history` provides a full audit trail per document, enabling questions like "how many times was this issue attempted before it succeeded?"
- Result sync back to the source document means consumers don't need to join against worker_tasks — the document itself carries its latest worker outcome
- `syncFromWorkerTask` handles the two entry paths (normal init vs. direct dispatch) gracefully, preventing orphaned tasks
- Progress updates via `updateProgress` are lightweight JSONB merges — they don't create new rows or change state, keeping the history clean
- Typed runners allow specialized execution strategies per task category while sharing the same dispatch and tracking infrastructure
- Agent sessions provide isolation between concurrent workers, preventing context bleed across tasks

## Code Example

```javascript
// Complete dispatch cycle: submit → init → start → progress → complete → sync

async function executeWorkerTask(documentId, taskType, runnerFn) {
  // 1. Dispatch and initialize tracking
  const task = await dispatchTask(documentId, taskType);

  // 2. Mark as started
  await markStarted(documentId);

  try {
    // 3. Execute with progress reporting
    const result = await runnerFn(task, {
      onProgress: (msg) => updateProgress(documentId, msg),
    });

    // 4. Complete and sync result to document
    await markCompleted(documentId, result);
    return result;
  } catch (error) {
    await markCompleted(documentId, {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Usage with typed runner
const result = await executeWorkerTask(
  documentId,
  'solve-issue',
  solveIssueRunner.run
);
// result.pr_url → task status is 'pr_created'
// result.abandoned → task status is 'abandoned'
// no error field → task status is 'completed'
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
