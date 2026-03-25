# Stale State Recovery on Startup

> Before accepting requests, clean up all inconsistent state left behind by an ungraceful shutdown.

## Problem

When a process crashes or is killed, in-flight work is frozen mid-execution. On the next start, the system inherits a lie: improvements marked `in_progress` that nobody is processing, workflow executions that will never complete, job locks held by a dead PID, and conversation histories littered with repeated error messages that train the model to give up. Without cleanup, the system either deadlocks on phantom locks or compounds past failures.

## Context

This pattern applies to any long-running agent or orchestration process that:

- Persists execution state to a database between restarts
- Uses distributed locks tied to process identity (PID or instance ID)
- Maintains conversation history that influences future model behavior
- Can crash ungracefully (OOM kill, hardware failure, deployment interrupt)

The cleanup runs once, synchronously, during the startup sequence in `index.js` — after the database connection is ready but before the HTTP server begins accepting traffic.

## Solution

Four sequential cleanup operations run at startup. Each is scoped to "state that was owned by a previous process instance and is now orphaned."

**1. Stale improvements** — Any improvement record stuck in `in_progress` from a prior run is reset to `pending` so it can be retried.

**2. Stale workflow executions** — Workflows that were `running` when the process died are transitioned to `failed` with an explicit reason (`"process_restart"`), preventing them from appearing active indefinitely.

**3. Orphaned locks** — Job locks store the PID that acquired them. On startup, any lock held by a PID that is no longer alive is released. This avoids the need for lock TTLs as the primary safety mechanism.

**4. Learned helplessness pruning** — Conversation history is scanned for messages containing repeated model-failure phrases (e.g., "I'm unable to", "I can't do that"). Runs of these messages are pruned before the process begins serving requests, preventing the model from seeing a history that normalizes failure and reinforcing the same broken behavior.

Each step logs the count of affected records. Zero is a valid and expected result on clean shutdowns.

## Implications

- Startup is slightly slower when there is state to clean — acceptable because correctness outweighs speed at boot time.
- Marking orphaned workflows as `failed` (rather than silently deleting them) preserves audit history while unblocking downstream consumers.
- Learned helplessness pruning is lossy — error messages are permanently removed. This is intentional; stale failure context has negative value.
- This pattern assumes a single active process per database. Multi-instance deployments require the lock-release step to check the PID on the specific host, or to use a distributed lock store with TTLs instead.

## Code Example

```js
// index.js — startup sequence (before server.listen)

async function recoverStaleState(db) {
  // 1. Reset stale improvements
  const { count: stuckImprovements } = await db.improvements.updateMany(
    { status: 'in_progress' },
    { status: 'pending', startedAt: null }
  );
  logger.info(`Startup cleanup: reset ${stuckImprovements} stale improvements`);

  // 2. Fail stale workflow executions
  const { count: stuckWorkflows } = await db.workflowExecutions.updateMany(
    { status: 'running' },
    { status: 'failed', failReason: 'process_restart', endedAt: new Date() }
  );
  logger.info(`Startup cleanup: failed ${stuckWorkflows} stale workflow executions`);

  // 3. Release orphaned locks
  const locks = await db.jobLocks.findAll({ where: { heldBy: { $ne: null } } });
  const deadLocks = locks.filter(lock => !isPidAlive(lock.heldByPid));
  await db.jobLocks.releaseMany(deadLocks.map(l => l.id));
  logger.info(`Startup cleanup: released ${deadLocks.length} orphaned locks`);

  // 4. Prune learned helplessness from conversation history
  const FAILURE_PATTERNS = [/I('m| am) unable to/i, /I can't do that/i];
  const pruned = await pruneConversationMessages(db, FAILURE_PATTERNS);
  logger.info(`Startup cleanup: pruned ${pruned} learned-helplessness messages`);
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
