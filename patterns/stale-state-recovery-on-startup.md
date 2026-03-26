# Stale State Recovery on Startup

> Before accepting requests, clean up stale locks and orphaned task states left behind by an ungraceful shutdown.

## Problem

When a process crashes or is killed, in-flight work is frozen mid-execution. On the next start, the system inherits inconsistent state: tasks marked `in_progress` that nobody is processing, workflow executions that will never complete, and job locks held by a dead PID. Without cleanup, the system either deadlocks on phantom locks or leaves orphaned work blocking new execution.

## Context

This pattern applies to any long-running agent or orchestration process that:

- Persists execution state to a database between restarts
- Uses distributed locks tied to process identity (PID or instance ID)
- Can crash ungracefully (OOM kill, hardware failure, deployment interrupt)

The cleanup runs once, synchronously, during the startup sequence in `index.js` — after the database connection is ready but before the HTTP server begins accepting traffic.

## Solution

Sequential cleanup operations run at startup. Each is scoped to "state that was owned by a previous process instance and is now orphaned."

**1. Release orphaned locks** — Job locks store the PID that acquired them. On startup, any lock held by a PID that is no longer alive is released. This avoids the need for lock TTLs as the primary safety mechanism.

**2. Reset stuck tasks** — Any task record stuck in `in_progress` from a prior run is reset to `pending` so it can be retried by the next available worker.

**3. Fail stale workflow executions** — Workflows that were `running` when the process died are transitioned to `failed` with an explicit reason (`"process_restart"`), preventing them from appearing active indefinitely.

Each step logs the count of affected records. Zero is a valid and expected result on clean shutdowns.

## Implications

- Startup is slightly slower when there is state to clean — acceptable because correctness outweighs speed at boot time.
- Marking orphaned workflows as `failed` (rather than silently deleting them) preserves audit history while unblocking downstream consumers.
- This pattern assumes a single active process per database. Multi-instance deployments require the lock-release step to check the PID on the specific host, or to use a distributed lock store with TTLs instead.
- The cleanup is intentionally conservative — it only touches state that is provably orphaned (held by dead PIDs, stuck in transient states with no active owner).

## Code Example

```js
// index.js — startup sequence (before server.listen)

async function recoverStaleState(db) {
  // 1. Release orphaned locks
  const locks = await db.jobLocks.findAll({ where: { heldBy: { $ne: null } } });
  const deadLocks = locks.filter(lock => !isPidAlive(lock.heldByPid));
  await db.jobLocks.releaseMany(deadLocks.map(l => l.id));
  logger.info(`Startup cleanup: released ${deadLocks.length} orphaned locks`);

  // 2. Reset stuck tasks
  const { count: stuckTasks } = await db.tasks.updateMany(
    { status: 'in_progress' },
    { status: 'pending', startedAt: null }
  );
  logger.info(`Startup cleanup: reset ${stuckTasks} stuck tasks`);

  // 3. Fail stale workflow executions
  const { count: stuckWorkflows } = await db.workflowExecutions.updateMany(
    { status: 'running' },
    { status: 'failed', failReason: 'process_restart', endedAt: new Date() }
  );
  logger.info(`Startup cleanup: failed ${stuckWorkflows} stale workflow executions`);
}

async function bootstrap() {
  await db.connect();
  await recoverStaleState(db);
  server.listen(PORT, () => logger.info(`Listening on ${PORT}`));
}
```

## Related Patterns

- [Graceful Shutdown Ordering](./graceful-shutdown-ordering.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
