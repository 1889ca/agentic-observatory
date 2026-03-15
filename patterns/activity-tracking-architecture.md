# Activity Tracking Architecture

> Three-layer tracking combining JSONL job logs, database session metadata, and in-memory rolling windows for real-time and historical activity visibility.

## Problem

With multiple satellite workers running concurrently, there's no unified view of what's happening. Activity data is scattered across individual process outputs, making it impossible to answer "what are my agents doing right now?" or "what happened in the last hour?" Different query patterns need different storage: real-time dashboards need in-memory speed, post-mortems need persistent logs, and aggregate views need structured metadata.

## Context

- An orchestrator managing multiple concurrent satellite worker instances
- Need for real-time dashboard showing agent activity
- Historical queries for post-mortem debugging
- Full replay capability for individual jobs
- Memory-bounded constraints — can't store unbounded data in memory

## Solution

The system uses a **three-layer tracking architecture**, each optimized for different query patterns:

### Layer 1: JSONL Job Logs (Full Replay)

Each satellite job produces a JSONL log file organized by date:

```
data/satellite-logs/
  2026-03-09/
    job-abc123.jsonl
    job-def456.jsonl
```

Each line is a structured event covering the full job lifecycle:

```javascript
// satellite/logging.js
function appendToLog(jobId, event) {
  const logDir = `data/satellite-logs/${formatDate(new Date())}`;
  mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/${jobId}.jsonl`;
  appendFileSync(logPath, JSON.stringify(event) + '\n');
}

// Three event types per job:
{ type: 'meta', jobId, cwd, prompt, startedAt }    // Job start
{ type: 'chunk', ts, text, stderr: false }           // Output stream
{ type: 'finish', ts, exit_code, byteCount }         // Job end
```

This provides full replay capability for any individual job — every byte of output is preserved.

### Layer 2: Database Session Metadata (Structured Queries)

The orchestrator tracks structured metadata about each satellite session in a database table:

```sql
CREATE TABLE satellite_sessions (
  job_id TEXT PRIMARY KEY,
  task_id TEXT,
  cwd TEXT,
  project TEXT,
  prompt TEXT,
  status TEXT DEFAULT 'running',
  exit_code INTEGER,
  log_path TEXT,
  byte_count INTEGER,
  result_summary TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration REAL
);
```

This enables structured queries without parsing raw logs:

```javascript
// "Show me all jobs for project X that failed in the last 24 hours"
const failures = await db.query(`
  SELECT * FROM satellite_sessions
  WHERE project = $1 AND exit_code != 0
    AND started_at > datetime('now', '-1 day')
  ORDER BY started_at DESC
`, [projectName]);
```

### Layer 3: In-Memory Rolling Window (Real-Time)

An in-memory activity tracker provides instant snapshots with bounded memory usage:

```javascript
// activity-tracker.js
const activityBuffers = new Map();
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function recordActivity(key) {
  if (!activityBuffers.has(key)) activityBuffers.set(key, []);
  const buf = activityBuffers.get(key);
  buf.push(Date.now());
  // Prune entries outside the window
  while (buf.length > 0 && buf[0] < Date.now() - WINDOW_MS) {
    buf.shift();
  }
}

// Heartbeat every 10s for active jobs
setInterval(() => {
  for (const run of getActiveRuns()) {
    recordActivity(run.taskId);
    if (run.satId) recordActivity(`sat:${run.satId}`);
  }
}, 10_000);
```

### Real-Time Event Emission

Active jobs emit events through the task runner for live UI updates:

```javascript
// task-runner.js
agentEvents.emit('start', { id: taskId, jobId, satId });
agentEvents.emit('chunk', { id: taskId, text: chunk });
agentEvents.emit('done', { id: taskId, output, exitCode, duration });
```

### Correlation

All three layers share `jobId` as a correlation key, enabling drill-down:

```
Dashboard (Layer 3: in-memory)
  → Session record (Layer 2: database)
    → Full JSONL log (Layer 1: file)
```

## Implications

- JSONL logs grow per day — needs periodic cleanup or archival (log rotation not yet automated)
- Database session metadata enables fast aggregate queries (by project, by status, by date range) without scanning log files
- In-memory rolling window provides instant response for "what's active now?" but loses data on restart
- The 10-minute window is a trade-off: long enough to detect stalls, short enough to bound memory
- Byte count is a rough proxy for "how much work happened" — not all bytes represent equal effort
- No cross-day aggregation without explicit queries — each day's logs are isolated files

## Code Example

```javascript
// Three layers working together for a single job lifecycle:

// 1. Job starts — all three layers record it
activeRuns.set(taskId, { jobId, startTime: Date.now() });
agentEvents.emit('start', { id: taskId, jobId });
await db.query(
  `INSERT INTO satellite_sessions (job_id, task_id, cwd, project, prompt, status, started_at)
   VALUES ($1, $2, $3, $4, $5, 'running', $6)`,
  [jobId, taskId, cwd, project, prompt, new Date().toISOString()]
);
appendToLog(jobId, { type: 'meta', jobId, cwd, prompt, startedAt: new Date() });

// 2. Output streams — Layer 1 (file) and Layer 3 (events)
appendToLog(jobId, { type: 'chunk', ts: Date.now(), text: chunk });
agentEvents.emit('chunk', { id: taskId, text: chunk });
recordActivity(taskId);

// 3. Job completes — all three layers close out
appendToLog(jobId, { type: 'finish', ts: Date.now(), exit_code: exitCode, byteCount });
await db.query(
  `UPDATE satellite_sessions SET status = $1, exit_code = $2, byte_count = $3,
   ended_at = $4, duration = $5 WHERE job_id = $6`,
  [exitCode === 0 ? 'completed' : 'failed', exitCode, byteCount, new Date().toISOString(), duration, jobId]
);
agentEvents.emit('done', { id: taskId, output, exitCode, duration });
activeRuns.delete(taskId);
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
