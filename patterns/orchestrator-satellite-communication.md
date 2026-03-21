# Orchestrator-Worker Communication

> Event-bus-driven task dispatch with DB-persisted task lifecycle, worker registration via Socket.io, and GitHub CC fallback when workers are offline.

## Problem

An orchestrator needs to dispatch heterogeneous work (code generation, issue solving, maintenance tasks) to AI agent workers, track execution through multiple terminal states, and synchronize results back to the originating documents. Simple "pending/running/done" state machines miss real-world outcomes like PR creation or task abandonment. Without execution history per document, there's no way to answer "how many times has this document been worked on, and what happened each time?"

## Context

- A central orchestrator dispatching work to connected Socket.io workers
- Workers register dynamically at runtime — availability is not guaranteed
- Tasks queue in a persistent taskQueue when no worker is available
- GitHub CC (Claude Code) serves as a fallback executor when all workers are offline
- Workers can produce multiple outcome types: successful completion, failure, PR creation, or voluntary abandonment
- Isolated execution contexts via agent sessions to prevent cross-task contamination

## Solution

### Architecture Overview

Task dispatch uses an internal event bus (`internalBus`) for event aggregation rather than direct Socket.io dequeue. Tasks are persisted in the database with a full lifecycle state machine (pending -> assigned -> running -> completed/failed/abandoned). The Socket.io layer still exists for real-time worker communication, but task state management has moved to DB-backed persistence with event-driven transitions.

### Worker Registration via Socket.io

Workers announce themselves to the orchestrator on connect using a `worker:register` event. The orchestrator maintains an in-memory registry of available workers keyed by socket ID:

```javascript
// orchestrator/workerRegistry.js
io.on('connection', (socket) => {
  socket.on('worker:register', ({ capabilities, workerId }) => {
    registry.set(socket.id, { socket, capabilities, workerId, busy: false });

    // Notify the event bus that a worker is available
    internalBus.emit('worker:available', { socketId: socket.id, capabilities });
  });

  socket.on('disconnect', () => {
    registry.delete(socket.id);
  });
});
```

### DB-Persisted Task Lifecycle

Tasks are persisted in the database with a state machine governing transitions. The `internalBus` listens for events and triggers state transitions:

```javascript
// orchestrator/taskLifecycle.js
const TASK_STATES = ['pending', 'assigned', 'running', 'completed', 'failed', 'abandoned'];

async function createTask(task) {
  const record = await db.query(`
    INSERT INTO tasks (id, type, payload, status, created_at)
    VALUES ($1, $2, $3, 'pending', NOW()) RETURNING *
  `, [task.id, task.type, JSON.stringify(task.payload)]);

  internalBus.emit('task:created', record);
  return record;
}

// Event-driven dispatch: when a worker becomes available, assign pending tasks
internalBus.on('worker:available', async ({ socketId, capabilities }) => {
  const task = await db.query(`
    UPDATE tasks SET status = 'assigned', assigned_to = $1, assigned_at = NOW()
    WHERE id = (
      SELECT id FROM tasks WHERE status = 'pending' AND type = ANY($2)
      ORDER BY created_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    ) RETURNING *
  `, [socketId, capabilities]);

  if (task) {
    const worker = registry.get(socketId);
    worker.socket.emit('task:assign', {
      taskId: task.id, type: task.type, payload: task.payload,
    });
  }
});
```

### Completion Reporting

Workers emit `task:complete` when finished. The orchestrator persists the outcome and emits events for downstream consumers:

```javascript
// worker/index.js — worker side
socket.on('task:assign', async ({ taskId, type, payload }) => {
  try {
    const result = await runTask(type, payload);
    socket.emit('task:complete', { taskId, status: 'completed', result });
  } catch (err) {
    socket.emit('task:complete', { taskId, status: 'failed', error: err.message });
  }
});

// orchestrator/taskLifecycle.js — orchestrator side
socket.on('task:complete', async ({ taskId, status, result, error }) => {
  const worker = registry.get(socket.id);
  if (worker) worker.busy = false;

  await db.query(`
    UPDATE tasks SET status = $1, result = $2, error = $3, completed_at = NOW()
    WHERE id = $4
  `, [status, JSON.stringify(result), error, taskId]);

  internalBus.emit('task:completed', { taskId, status });
  internalBus.emit('worker:available', { socketId: socket.id, capabilities: worker.capabilities });
});
```

### GitHub CC Fallback

When the worker registry is empty, the orchestrator spawns a GitHub CC (Claude Code) process as a synchronous fallback. This ensures tasks are never stranded when no persistent workers are online:

```javascript
// orchestrator/githubCCFallback.js
async function run(task) {
  const prompt = buildPrompt(task);
  await spawnCC({ prompt, workdir: task.workdir });
  // CC exits when done — result is captured via git push / PR creation
}
```

## Implications

- The `internalBus` event aggregation decouples task creation from dispatch — any component can emit `task:created` and the bus routes it to the assignment logic
- DB-persisted task state (with `FOR UPDATE SKIP LOCKED`) is the source of truth, surviving restarts and enabling horizontal scaling across multiple orchestrator instances
- Socket.io remains the real-time transport for pushing assignments to workers and receiving completions, but it no longer owns task state
- The event-driven `worker:available` pattern replaces explicit queue draining — when a worker registers or completes a task, the bus triggers assignment automatically
- The GitHub CC fallback ensures no task is permanently stranded, but it is synchronous and slower than a live worker; it should be treated as a safety net, not a primary path
- The full lifecycle state machine (pending -> assigned -> running -> completed/failed/abandoned) provides richer observability than a simple pending/done model
- Agent sessions still provide isolation between concurrent workers, preventing context bleed across tasks

## Code Example

```javascript
// Full lifecycle: task created, worker comes online, event bus assigns, worker reports completion

// --- Orchestrator side ---

io.on('connection', (socket) => {
  socket.on('worker:register', ({ workerId, capabilities }) => {
    registry.set(socket.id, { socket, workerId, capabilities, busy: false });
    internalBus.emit('worker:available', { socketId: socket.id, capabilities });
  });

  socket.on('task:complete', async ({ taskId, status, result, error }) => {
    const worker = registry.get(socket.id);
    if (worker) worker.busy = false;

    await db.query(
      `UPDATE tasks SET status = $1, result = $2, error = $3, completed_at = NOW() WHERE id = $4`,
      [status, JSON.stringify(result), error, taskId]
    );

    internalBus.emit('task:completed', { taskId, status });
    internalBus.emit('worker:available', { socketId: socket.id, capabilities: worker.capabilities });
  });

  socket.on('disconnect', () => registry.delete(socket.id));
});

// Create a new task — the event bus handles dispatch when a worker is available
await createTask({ id: 'task-42', type: 'solve-issue', payload: { issueId: 99 } });

// --- Worker side ---

socket.emit('worker:register', { workerId: 'cc-worker-1', capabilities: ['solve-issue', 'coding'] });

socket.on('task:assign', async ({ taskId, type, payload }) => {
  try {
    const result = await runTask(type, payload);
    socket.emit('task:complete', { taskId, status: 'completed', result });
  } catch (err) {
    socket.emit('task:complete', { taskId, status: 'failed', error: err.message });
  }
});
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
