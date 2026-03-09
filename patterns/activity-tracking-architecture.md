# Activity Tracking Architecture

> Multi-layered activity tracking across distributed agent jobs with audit trails and real-time monitoring.

## Problem

With multiple CC satellites running concurrently, there's no unified view of what's happening. Activity data is scattered across individual session logs, making it impossible to answer "what are my agents doing right now?" or "what happened in the last hour?" Without structured tracking, debugging failures requires manually correlating timestamps across log files from different processes.

## Context

- An orchestrator managing multiple concurrent CC satellite instances
- Need for real-time dashboard showing agent activity
- Historical queries for post-mortem debugging
- Memory-bounded constraints — can't store raw output forever
- Multiple tracking granularities: per-job, per-flow, per-step

## Solution

The system uses a **three-layer tracking architecture**, each serving different query patterns:

### Layer 1: Satellite JSONL Logs (Per-Job Detail)

Each satellite job produces a JSONL log file organized by date:

```
data/satellite-logs/
  2026-03-09/
    job-abc123.jsonl
    job-def456.jsonl
```

Each line is a structured event:
```javascript
{ type: 'meta', jobId, cwd, prompt, startedAt }   // Job start
{ type: 'chunk', ts, text, stderr: false }          // Output stream
{ type: 'finish', ts, exit_code, duration }         // Job end
```

This provides full replay capability for any individual job.

### Layer 2: Audit Sessions (Orchestrator View)

The orchestrator maintains its own tracking with `startSession()` / `finishSession()` calls that record:
- Which task spawned the job
- Duration and output byte count
- Exit code and completion status
- Flow association (which flow/step triggered this job)

This enables queries like "show me all jobs from the code-review flow" without parsing raw logs.

### Layer 3: Real-Time Event Stream

Active jobs emit events through the task runner:
```javascript
agentEvents.emit('start', { taskId, jobId, satId });
agentEvents.emit('chunk', { taskId, jobId, text });
agentEvents.emit('done', { taskId, jobId, output, exitCode });
```

The `activeRuns` Map provides an instant snapshot:
```javascript
// taskId → { jobId, startTime, satId }
const status = getSatelliteStatus();
// Returns: { jobs: [{ id, cwd, pid, logPath, byteCount }], max }
```

### Correlation

All layers share the `jobId` as a correlation key, enabling drill-down from high-level dashboard → audit record → raw JSONL log.

## Implications

- JSONL logs grow indefinitely per day — needs periodic cleanup (not yet implemented)
- Audit sessions are SQLite-backed, so queries are fast but schema is fixed
- Event stream is ephemeral — only shows currently active jobs
- No aggregation across days without custom queries
- Byte count tracking is a rough proxy for "how much work happened" — not all bytes are equal

## Code Example

```javascript
// Three layers working together for a single job:

// 1. Task runner starts job, tracks in memory
activeRuns.set(taskId, { jobId, startTime: Date.now(), satId });
agentEvents.emit('start', { taskId, jobId, satId });

// 2. Audit log records orchestrator-level metadata
auditLog.startSession(jobId, { task: taskId, flow: flowId, step: stepIdx });

// 3. Satellite worker writes JSONL per chunk
fs.appendFileSync(logPath, JSON.stringify({ type: 'chunk', ts, text }) + '\n');

// On completion — all three layers close out
agentEvents.emit('done', { taskId, jobId, output, exitCode });
auditLog.finishSession(jobId, exitCode, totalBytes);
activeRuns.delete(taskId);
```

## Related Patterns

- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
