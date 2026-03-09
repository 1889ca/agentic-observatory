# Orchestrator-Satellite Communication

> Structured protocol for reliable communication between an orchestrator and its worker agents.

## Problem

An orchestrator needs to dispatch work to multiple CC instances, monitor their progress, detect failures, and collect results. Standard process management (spawn + wait) is too coarse — you need streaming output, cancellation, concurrent job limits, and crash recovery. But building a full RPC framework is overkill for what amounts to "run this prompt and tell me what happens."

## Context

- One orchestrator process managing N satellite worker instances
- Satellites are long-lived daemon processes, not spawned per-task
- Jobs can run for up to 45 minutes
- Need for concurrent job limits, streaming output, and graceful shutdown
- Orchestrator may restart independently of satellites (and vice versa)

## Solution

### Unix Socket + Newline-Delimited JSON

The satellite worker runs as a standalone daemon listening on a Unix socket. The protocol is dead simple — each message is one line of JSON:

```javascript
// Client → Satellite
{ type: 'run', id: 'job-abc', prompt: '...', cwd: '/project', model: 'opus' }
{ type: 'cancel', id: 'job-abc' }
{ type: 'subscribe', id: 'job-abc' }  // Reconnect to surviving job
{ type: 'status' }                     // Query all active jobs

// Satellite → Client
{ id: 'job-abc', status: 'started' }
{ id: 'job-abc', chunk: 'Working on...', stderr: false }
{ id: 'job-abc', output: 'Final result', exit_code: 0, done: true, logPath: '...' }
```

Why Unix socket over HTTP: no serialization overhead, no port conflicts, no TLS complexity, and the OS handles connection lifecycle. The socket file acts as a natural service discovery mechanism — if the file exists, the satellite is (probably) running.

### Concurrency Control

The satellite enforces a hard limit on concurrent jobs (default: 4, configurable via `RILEY_SATELLITE_MAX_JOBS`). Requests beyond the limit are rejected immediately — the orchestrator can queue and retry.

```javascript
if (activeJobs.size >= maxJobs) {
  socket.write(JSON.stringify({ id, error: 'at capacity' }) + '\n');
  return;
}
```

### Job Lifecycle

1. **Start:** Satellite spawns a CC process with the given prompt, cwd, and model
2. **Stream:** Output chunks forwarded to client as they arrive
3. **Complete:** Final message includes full output, exit code, and log path
4. **Timeout:** Jobs exceeding 45 minutes are force-killed (configurable via `RILEY_SATELLITE_JOB_TIMEOUT_MS`)

### Reconnection Protocol

The `subscribe` message type enables crash recovery. After an orchestrator restart:

1. Query satellite status to discover surviving jobs
2. Subscribe to each surviving job by ID
3. Receive remaining output chunks and final result
4. Job results are cached briefly (30s) for race conditions where the job finishes between status query and subscribe

```javascript
// Orchestrator recovery sequence
const status = await querySatellite({ type: 'status' });
for (const job of status.jobs) {
  if (myFlows.has(job.id)) {
    await subscribeTo(job.id); // Resume receiving output
  }
}
```

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new connections
2. Give active jobs 5-second grace period
3. Force-kill remaining jobs
4. Log final state for each job
5. Clean up socket file

## Implications

- Unix socket limits to single-machine deployment — no distributed satellite pools (acceptable for personal orchestrator)
- NDJSON has no built-in schema validation — malformed messages cause silent failures
- The 30-second result cache means very fast jobs might be missed if subscribe arrives late
- No authentication on the socket — relies on filesystem permissions
- Single satellite daemon is a SPOF — if it dies, all jobs die (mitigated by launchd auto-restart)
- No backpressure mechanism — fast-producing satellites can overwhelm slow consumers

## Code Example

```javascript
// Task runner — complete dispatch cycle
async function runTask(task) {
  const jobId = `${task.id}-${Date.now()}`;
  const socket = net.connect(SATELLITE_SOCKET);

  socket.write(JSON.stringify({
    type: 'run',
    id: jobId,
    prompt: task.prompt,
    cwd: task.workdir || process.cwd(),
    model: task.model || 'sonnet'
  }) + '\n');

  activeRuns.set(task.id, { jobId, startTime: Date.now() });

  return new Promise((resolve) => {
    let output = '';
    socket.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.chunk) {
          output += msg.chunk;
          agentEvents.emit('chunk', { taskId: task.id, jobId, text: msg.chunk });
        }
        if (msg.done) {
          activeRuns.delete(task.id);
          resolve({ success: msg.exit_code === 0, output: msg.output, jobId });
        }
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
