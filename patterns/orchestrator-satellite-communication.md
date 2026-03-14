# Orchestrator-Satellite Communication

> Structured protocol for reliable communication between an orchestrator and its AI agent satellites via HTTP dispatch and database-backed job queuing.

## Problem

An orchestrator needs to dispatch work to multiple AI agent instances, monitor their progress, detect failures, and collect results. Standard process management (spawn + wait) is too coarse — you need job queuing, cancellation, concurrent job limits, and crash recovery. But building a full RPC framework is overkill for what amounts to "run this prompt and tell me what happens."

## Context

- One orchestrator process managing N satellite instances
- Satellites are stateless from the orchestrator's perspective — they check in periodically via HTTP
- Jobs can run for extended periods (minutes to an hour)
- Need for concurrent job limits, persistent job state, and graceful failure handling
- Orchestrator and satellites may restart independently of each other
- Job queue is backed by PostgreSQL, providing durability, atomic state transitions, and row-level locking for conflict detection
- Transport is HTTP — no persistent connections, no WebSocket complexity, no reconnection logic

## Solution

### HTTP-Based Satellite Registration

Satellites register with the orchestrator by calling a check-in endpoint. The orchestrator maintains a registry of known satellites with their last check-in time, using staleness to detect failures:

```javascript
// POST /api/satellite/checkin
async function handleCheckin(req, res) {
  const { id, description, maxConcurrent } = req.body;

  await db.query(`
    INSERT INTO satellites (id, description, max_concurrent, last_checkin)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (id) DO UPDATE
    SET last_checkin = NOW(), description = $2
  `, [id, description, maxConcurrent]);

  res.json({ status: 'ok' });
}
```

### PostgreSQL Job Queue

Jobs are inserted into a database table with atomic status transitions. The queue provides durability (survives restarts), conflict detection (row-level locks), and distributed visibility (any process can read state):

```javascript
// lib/worker/dispatch.js
async function enqueueJob({ prompt, cwd, model, priority }) {
  const { rows } = await db.query(`
    INSERT INTO jobs (prompt, cwd, model, priority, status, created_at)
    VALUES ($1, $2, $3, $4, 'pending', NOW())
    RETURNING id
  `, [prompt, cwd, model, priority || 0]);

  return rows[0].id;
}
```

### Capacity Checking and Conflict Detection

Before dispatching, the orchestrator queries the database for worker capacity and conflicting jobs. Row-level locks prevent two dispatchers from assigning the same slot:

```javascript
async function findAvailableWorker(job) {
  // Lock rows to prevent race conditions during assignment
  const { rows } = await db.query(`
    SELECT s.id, s.max_concurrent,
      COUNT(j.id) AS active_count
    FROM satellites s
    LEFT JOIN jobs j ON j.assigned_to = s.id AND j.status = 'running'
    WHERE s.last_checkin > NOW() - INTERVAL '2 minutes'
    GROUP BY s.id, s.max_concurrent
    HAVING COUNT(j.id) < s.max_concurrent
    FOR UPDATE OF s
  `);

  for (const worker of rows) {
    // Conflict detection — no two jobs in the same working directory
    const conflict = await db.query(`
      SELECT 1 FROM jobs
      WHERE assigned_to = $1 AND cwd = $2 AND status = 'running'
    `, [worker.id, job.cwd]);

    if (conflict.rowCount === 0) return worker;
  }

  return null;
}
```

### HTTP Job Dispatch

The orchestrator dispatches jobs by sending an HTTP POST to the satellite. The satellite runs the job asynchronously and reports results back via HTTP when done:

```javascript
// Orchestrator dispatches work via HTTP
async function dispatchJob(worker, jobId) {
  const job = await db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);

  await db.query(`
    UPDATE jobs SET status = 'running', assigned_to = $1, started_at = NOW()
    WHERE id = $2
  `, [worker.id, jobId]);

  // Fire HTTP request to the satellite
  await fetch(`http://${worker.host}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      prompt: job.rows[0].prompt,
      cwd: job.rows[0].cwd,
      model: job.rows[0].model
    })
  });
}

// Satellite reports completion back via HTTP
// POST /api/satellite/report
async function handleReport(req, res) {
  const { jobId, exitCode, output, logPath } = req.body;

  await db.query(`
    UPDATE jobs
    SET status = $1, exit_code = $2, output = $3, log_path = $4, completed_at = NOW()
    WHERE id = $5
  `, [exitCode === 0 ? 'completed' : 'failed', exitCode, output, logPath, jobId]);

  res.json({ status: 'ok' });
}
```

### Failure Detection and Recovery

Without persistent connections, failure detection relies on database polling. A periodic sweep marks stale jobs as failed and makes them available for retry:

```javascript
// Periodic sweep for stale/orphaned jobs
async function recoverStaleJobs() {
  // Mark jobs as failed if their satellite hasn't checked in
  await db.query(`
    UPDATE jobs SET status = 'failed', completed_at = NOW()
    WHERE status = 'running'
    AND assigned_to IN (
      SELECT id FROM satellites
      WHERE last_checkin < NOW() - INTERVAL '5 minutes'
    )
  `);

  // Re-queue retryable failed jobs
  await db.query(`
    UPDATE jobs SET status = 'pending', assigned_to = NULL, retries = retries + 1
    WHERE status = 'failed' AND retries < max_retries
  `);
}
```

### Graceful Shutdown

On shutdown signal:
1. Stop accepting new job dispatches
2. Update orchestrator status in the database so satellites can detect it
3. Wait for in-flight HTTP responses (grace period)
4. Mark remaining pending jobs as paused for resumption on restart

## Implications

- HTTP dispatch is stateless — no heartbeat/keepalive complexity, but failure detection has latency (polling interval)
- PostgreSQL queue provides crash recovery for free — pending jobs survive orchestrator restarts
- Row-level locking in PostgreSQL replaces in-memory conflict detection, making it safe for multiple orchestrator instances
- No streaming output — satellites report results when done, so long-running jobs are opaque until completion
- Database polling for status adds slight latency compared to event-driven models, but eliminates connection management overhead
- Horizontal scaling is straightforward — add more satellites, they just start checking in via HTTP
- Stale satellite detection depends on check-in frequency — too aggressive causes false positives, too lax delays failure recovery

## Code Example

```javascript
// Complete dispatch cycle with timeout and database-backed state
async function runJob(jobConfig, timeoutMs = 45 * 60 * 1000) {
  const jobId = await enqueueJob(jobConfig);
  const worker = await findAvailableWorker(jobConfig);

  if (!worker) {
    // Job stays in 'pending' state in the queue — will be picked up later
    return { jobId, status: 'queued' };
  }

  await dispatchJob(worker, jobId);

  // Poll database for completion
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const { rows } = await db.query(
      'SELECT status, exit_code, output, log_path FROM jobs WHERE id = $1',
      [jobId]
    );

    if (rows[0].status === 'completed' || rows[0].status === 'failed') {
      return {
        jobId,
        success: rows[0].exit_code === 0,
        output: rows[0].output,
        logPath: rows[0].log_path
      };
    }

    await new Promise(r => setTimeout(r, 5000)); // Poll every 5s
  }

  // Timeout — mark as failed
  await db.query(
    "UPDATE jobs SET status = 'failed', completed_at = NOW() WHERE id = $1",
    [jobId]
  );
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
