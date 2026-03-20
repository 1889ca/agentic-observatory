# Orchestrator-Worker Communication

> Socket.io-based real-time task dispatch with a taskQueue dequeue pattern, worker registration via events, and GitHub CC fallback when workers are offline.

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

### Worker Registration via Socket.io

Workers announce themselves to the orchestrator on connect using a `worker:register` event. The orchestrator maintains an in-memory registry of available workers keyed by socket ID:

```javascript
// orchestrator/workerRegistry.js
io.on('connection', (socket) => {
  socket.on('worker:register', ({ capabilities, workerId }) => {
    registry.set(socket.id, { socket, capabilities, workerId, busy: false });

    // Drain any queued tasks this worker can handle
    drainQueue(socket.id);
  });

  socket.on('disconnect', () => {
    registry.delete(socket.id);
  });
});
```

### Task Assignment and the Dequeue Pattern

When a task arrives, the orchestrator attempts to find a free worker immediately. If none is available, the task is persisted to a queue and dequeued when a worker registers or becomes free:

```javascript
// orchestrator/taskDispatcher.js
async function dispatch(task) {
  const worker = findFreeWorker(task.type);

  if (worker) {
    assignToWorker(worker, task);
  } else {
    // Persist for later — queue survives restarts
    await taskQueue.enqueue(task);

    // If no workers at all, fall back to GitHub CC
    if (registry.size === 0) {
      await githubCCFallback.run(task);
    }
  }
}

async function drainQueue(socketId) {
  const worker = registry.get(socketId);
  let task;

  while ((task = await taskQueue.dequeue(worker.capabilities))) {
    assignToWorker(worker, task);
    if (worker.busy) break;
  }
}
```

### Task Assignment Event

The orchestrator pushes work to the worker via a `task:assign` event. The payload includes everything the worker needs to execute independently:

```javascript
// orchestrator/taskDispatcher.js
function assignToWorker(worker, task) {
  worker.busy = true;
  worker.socket.emit('task:assign', {
    taskId: task.id,
    type: task.type,
    payload: task.payload,
  });
}
```

### Completion Reporting

Workers emit `task:complete` when finished. The orchestrator receives it, marks the worker free, and drains the queue again:

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

// orchestrator/taskDispatcher.js — orchestrator side
socket.on('task:complete', async ({ taskId, status, result, error }) => {
  const worker = registry.get(socket.id);
  if (worker) worker.busy = false;

  await taskQueue.markDone(taskId, { status, result, error });

  // Immediately pick up next queued task if any
  drainQueue(socket.id);
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

- Socket.io dispatch is real-time and push-based — the orchestrator does not poll; workers pull work the moment they register or finish a prior task
- The `taskQueue.dequeue()` pattern decouples arrival from execution — tasks can accumulate during worker downtime and drain automatically on reconnect
- The GitHub CC fallback ensures no task is permanently stranded, but it is synchronous and slower than a live worker; it should be treated as a safety net, not a primary path
- Worker availability is ephemeral — the registry is in-memory, so a restart clears it; the persistent queue is the source of truth for unprocessed work
- `drainQueue` runs after both registration and task completion, so a single worker coming online can process a backlog without any external trigger
- The `task:complete` event carries the full outcome (status, result, error), giving the orchestrator everything it needs to update persistence and notify downstream consumers in one step
- Agent sessions still provide isolation between concurrent workers, preventing context bleed across tasks

## Code Example

```javascript
// Full lifecycle: worker comes online, picks up queued task, reports completion

// --- Orchestrator side ---

io.on('connection', (socket) => {
  socket.on('worker:register', ({ workerId, capabilities }) => {
    registry.set(socket.id, { socket, workerId, capabilities, busy: false });
    drainQueue(socket.id); // immediately assign any waiting tasks
  });

  socket.on('task:complete', async ({ taskId, status, result, error }) => {
    const worker = registry.get(socket.id);
    if (worker) worker.busy = false;

    await taskQueue.markDone(taskId, { status, result, error });
    drainQueue(socket.id); // pick up the next task without waiting
  });

  socket.on('disconnect', () => registry.delete(socket.id));
});

// Enqueue a new task — dispatch immediately if a worker is free
await dispatch({ id: 'task-42', type: 'solve-issue', payload: { issueId: 99 } });

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
