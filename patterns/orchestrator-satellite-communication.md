# Orchestrator-Satellite Communication

> Unix socket protocol with JSONL streaming for real-time orchestrator-to-satellite job dispatch and output streaming.

## Problem

An orchestrator needs to dispatch work to multiple AI agent instances, stream their output in real-time, detect failures, and collect results. HTTP polling introduces latency and complexity. Full RPC frameworks are overkill. What's needed is a lightweight protocol that supports streaming output, concurrent job limits, and crash recovery without the connection management overhead of WebSockets.

## Context

- One orchestrator process managing N satellite workers on the same machine
- Jobs run as Claude Code subprocesses and can produce large streaming output
- Need for concurrent job limits (global and per-project), cancellation, and crash recovery
- Orchestrator and satellites may restart independently
- Real-time output streaming is essential for long-running jobs (minutes to hours)

## Solution

### Unix Socket Protocol

The satellite runs as a daemon listening on a Unix socket. Communication uses newline-delimited JSON (NDJSON) — each message is a single JSON object followed by a newline. This is simpler than HTTP, has zero serialization overhead, and supports bidirectional streaming natively:

```javascript
// satellite-protocol.js
function sendRun(msg, callbacks) {
  const client = createConnection(SOCKET_PATH);

  client.on('connect', () => callbacks.onConnect?.());

  client.write(JSON.stringify({ type: 'run', ...msg }) + '\n');

  // Parse newline-delimited JSON responses
  let buffer = '';
  client.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.done) callbacks.onDone(parsed);
      else if (parsed.chunk) callbacks.onChunk(parsed);
      else if (parsed.error) callbacks.onError(parsed);
    }
  });

  return { client };
}
```

### Socket Server Message Types

The satellite socket server handles four message types:

- **`run`** — Spawn a new Claude Code subprocess with prompt, cwd, and model
- **`cancel`** — Kill a running job by ID
- **`subscribe`** — Attach to an existing job's output stream (for late-joining observers)
- **`status`** — Query active job count and details

```javascript
// satellite/socket-server.js
function handleMessage(client, msg) {
  switch (msg.type) {
    case 'run':
      if (activeJobs.size >= MAX_JOBS) {
        send(client, { id: msg.id, error: 'max_jobs_exceeded', done: true });
        return;
      }
      spawnJob(client, msg);
      break;
    case 'cancel':
      cancelJob(msg.id);
      break;
    case 'subscribe':
      subscribeToJob(client, msg.id);
      break;
    case 'status':
      send(client, { jobs: getActiveJobDetails(), max: MAX_JOBS });
      break;
  }
}
```

### Concurrency Limits

Two levels of concurrency control prevent resource exhaustion:

```javascript
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '8');
const MAX_JOBS_PER_PROJECT = parseInt(process.env.MAX_JOBS_PER_PROJECT || '3');
```

Global limits prevent machine overload. Per-project limits prevent one project from starving others. Both are checked before spawning.

### Streaming Output

Job output streams in real-time over the socket connection. Each chunk is sent as it arrives from the subprocess:

```javascript
// satellite/spawner.js
function spawnJob(client, msg) {
  const proc = spawn(CLAUDE_BIN, [...args], { cwd: msg.cwd, detached: true });

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    send(client, { id: msg.id, chunk: text });
    appendToLog(msg.id, { type: 'chunk', ts: Date.now(), text });
  });

  proc.on('exit', (code) => {
    send(client, { id: msg.id, output: collectedOutput, exit_code: code, done: true });
    appendToLog(msg.id, { type: 'finish', ts: Date.now(), exit_code: code });
  });
}
```

### Job Monitoring and Stall Detection

A periodic monitor (every 5 minutes) detects stuck jobs:

```javascript
// satellite/job-monitor.js — checks every 5 minutes
function checkJobs() {
  for (const job of activeJobs.values()) {
    const logInactive = Date.now() - job.lastLogTime > 10 * 60 * 1000;
    const cpuIdle = job.cpuUsage < 0.1;

    if (logInactive && cpuIdle) {
      // Stalled: no output for 10min AND CPU idle — kill it
      job.process.kill('SIGTERM');
    }
  }

  // Clean up orphaned dev servers (vite, webpack, next) reparented to init
  cleanupOrphanedProcesses();
}
```

### Kanban Queue Integration

Jobs don't go directly from the API to the satellite. Instead, they pass through a priority-based kanban queue that ticks every 100ms:

```javascript
// kanban-worker.js — polls every 100ms
function tick() {
  const pending = queue.getByPriority(); // critical > high > normal > operational

  for (const task of pending) {
    if (canLaunch(task)) {
      sendRun({
        id: `kanban-${task.id}`,
        prompt: task.prompt,
        cwd: task.workdir,
        model: task.model || 'sonnet',
      }, {
        onDone: (result) => markDone(task.id, result.output, result.exit_code),
        onError: () => retryWithBackoff(task), // 5s, 15s, 30s
      });
    }
  }
}
```

## Implications

- Unix sockets are local-only — satellites must run on the same machine as the orchestrator
- NDJSON protocol is simple to debug (just pipe the socket and read JSON lines)
- Streaming output means the orchestrator can show progress in real time, unlike poll-based systems
- Per-project concurrency limits prevent a single noisy project from monopolizing all workers
- Stall detection uses a two-check confirmation (idle CPU + no output) to avoid false positives
- The kanban queue decouples job submission from execution, enabling priority-based scheduling
- Output is capped at 10MB in memory with full logs written to disk, preventing OOM on verbose jobs

## Code Example

```javascript
// Complete dispatch cycle: API → kanban → satellite → streaming result
async function runTask(task) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const { client } = sendRun({
      id: task.id,
      prompt: task.prompt,
      cwd: task.workdir,
      model: task.model || 'sonnet',
    }, {
      onConnect() {
        trackJob(task.id, task.jobId, startTime);
      },
      onChunk(msg) {
        agentEvents.emit('chunk', { id: task.id, text: msg.chunk });
      },
      onDone(msg) {
        const duration = (Date.now() - startTime) / 1000;
        resolve({
          success: msg.exit_code === 0,
          duration,
          output: msg.output,
          exit_code: msg.exit_code,
        });
      },
      onError(err) {
        resolve({ success: false, error: err.message });
      },
    });
  });
}
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
