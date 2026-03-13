# Orchestrator-Satellite Communication

> Structured protocol for reliable communication between an orchestrator and its AI agent worker pool.

## Problem

An orchestrator needs to dispatch work to multiple AI agent instances, monitor their progress, detect failures, and collect results. Standard process management (spawn + wait) is too coarse — you need streaming output from long-running jobs, cancellation, concurrent job limits, and crash recovery. But building a full RPC framework is overkill for what amounts to "run this prompt and tell me what happens."

## Context

- One orchestrator process managing N worker instances (satellites)
- Workers are long-lived processes, not spawned per-task
- Jobs can run for extended periods (minutes to an hour)
- Need for concurrent job limits, streaming output, and graceful shutdown
- Orchestrator and workers may restart independently of each other
- Key transport decision: Socket.io (event-driven, reconnection built in), gRPC (typed, streaming), Unix sockets (simple, single-machine), or HTTP polling (stateless, distributed) — choose based on whether you need multi-machine, streaming, or simplicity

## Solution

### Event-Driven Worker Pool

Workers connect to the orchestrator over a persistent connection (e.g., Socket.io). Each worker reports its capacity on connect. The orchestrator maintains a live view of the worker pool and dispatches jobs to available workers with conflict detection.

```javascript
// Worker connects and reports capacity
io.on('connection', (socket) => {
  socket.on('worker:register', ({ workerId, maxConcurrent }) => {
    workers.set(workerId, {
      socket,
      maxConcurrent,
      activeJobs: new Set(),
      lastHeartbeat: Date.now()
    });
  });
});
```

### Capacity Checking and Conflict Detection

Before dispatching, the orchestrator checks that the target worker has capacity and that no conflicting job is already running (e.g., two jobs targeting the same project directory):

```javascript
function findAvailableWorker(job) {
  for (const [id, worker] of workers) {
    // Capacity check
    if (worker.activeJobs.size >= worker.maxConcurrent) continue;

    // Conflict detection — no two jobs in the same working directory
    const hasConflict = [...worker.activeJobs].some(
      activeJob => activeJob.cwd === job.cwd
    );
    if (hasConflict) continue;

    return { id, worker };
  }
  return null; // All workers busy or conflicting
}
```

### Job Dispatch and Streaming Results

The orchestrator dispatches jobs as events and receives streaming output. Workers emit structured events for each phase of the job lifecycle:

```javascript
// Orchestrator dispatches work
function dispatchJob(worker, job) {
  worker.socket.emit('job:run', {
    jobId: job.id,
    prompt: job.prompt,
    cwd: job.cwd,
    model: job.model || 'sonnet'
  });
  worker.activeJobs.add(job);
}

// Worker streams results back
socket.on('job:output', ({ jobId, chunk }) => {
  // Stream output to UI, logs, or parent flow
  emitToSubscribers(jobId, chunk);
});

socket.on('job:complete', ({ jobId, exitCode, output, logPath }) => {
  const worker = findWorkerByJob(jobId);
  worker.activeJobs.delete(jobId);
  resolveJob(jobId, { success: exitCode === 0, output, logPath });
});
```

### Reconnection and Recovery

When a worker disconnects (crash, network issue), the orchestrator marks its jobs as orphaned. When the worker reconnects, surviving jobs can be reattached:

```javascript
socket.on('disconnect', () => {
  const worker = findWorkerBySocket(socket);
  for (const job of worker.activeJobs) {
    job.status = 'orphaned';
    job.orphanedAt = Date.now();
  }
});

// On reconnect, worker reports surviving jobs
socket.on('worker:reconnect', ({ workerId, survivingJobs }) => {
  for (const jobId of survivingJobs) {
    reattachJob(workerId, jobId); // Resume output streaming
  }
});
```

### Graceful Shutdown

On shutdown signal:
1. Stop accepting new job dispatches
2. Notify workers to finish current jobs (grace period)
3. Force-cancel remaining jobs after timeout
4. Log final state for each job

## Implications

- Persistent connections (Socket.io, WebSocket) require heartbeat/keepalive logic to detect silent disconnects
- Event-driven dispatch is inherently async — the orchestrator must track job state across multiple events
- Conflict detection adds complexity but prevents data corruption from concurrent writes to the same project
- Worker pool model means idle workers consume resources — consider auto-scaling or hibernation for large deployments
- No built-in backpressure — fast-producing workers can overwhelm the orchestrator's event loop if output isn't consumed
- For single-machine setups, Unix sockets eliminate port management and network overhead at the cost of distribution

## Code Example

```javascript
// Complete dispatch cycle with timeout and error handling
async function runJob(job, timeoutMs = 45 * 60 * 1000) {
  const match = findAvailableWorker(job);
  if (!match) {
    throw new Error('No available workers — queuing');
  }

  const { id: workerId, worker } = match;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.socket.emit('job:cancel', { jobId: job.id });
      reject(new Error(`Job ${job.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    dispatchJob(worker, job);

    worker.socket.on('job:complete', (result) => {
      if (result.jobId === job.id) {
        clearTimeout(timer);
        resolve({
          success: result.exitCode === 0,
          output: result.output,
          logPath: result.logPath
        });
      }
    });

    worker.socket.on('job:error', (err) => {
      if (err.jobId === job.id) {
        clearTimeout(timer);
        reject(new Error(err.message));
      }
    });
  });
}
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
