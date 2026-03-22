# Task Deduplication

> Keyed deduplication preventing duplicate agent work using compound unique indexes and atomic conflict resolution.

## Problem

Multiple agents or triggers can independently decide the same work needs doing — a webhook fires twice, two satellites notice the same stale dependency, a retry races with a fresh dispatch. Without deduplication, the system performs redundant work, wastes compute, and can produce conflicting results when two agents modify the same resource concurrently.

## Context

- Multiple producers (agents, webhooks, schedules) can create tasks independently
- Race conditions between concurrent task creators are common
- Tasks are identified by a combination of type and parameters
- The system needs to know which creator "won" the race to avoid duplicate execution
- Database-level guarantees are preferred over application-level locking

## Solution

Each task is identified by a compound key derived from its type and parameters. A unique index on this compound key enforces deduplication at the database level. Task creation uses `INSERT ... ON CONFLICT DO NOTHING`, and the caller checks the affected row count to determine whether they won the dedup race or a duplicate already exists.

```javascript
// task-dedup.js
async function createTaskIfNew(db, { type, params, metadata }) {
  const dedupKey = buildDedupKey(type, params);

  const result = await db.query(`
    INSERT INTO tasks (type, params, dedup_key, status, metadata, created_at)
    VALUES ($1, $2, $3, 'pending', $4, NOW())
    ON CONFLICT (dedup_key) DO NOTHING
    RETURNING id
  `, [type, JSON.stringify(params), dedupKey, JSON.stringify(metadata)]);

  const won = result.rowCount > 0;
  return {
    created: won,
    taskId: won ? result.rows[0].id : null,
  };
}

function buildDedupKey(type, params) {
  const stable = JSON.stringify(params, Object.keys(params).sort());
  return `${type}:${stable}`;
}
```

The compound index ensures that even under heavy concurrency, only one row is inserted for a given type+params combination. No advisory locks, no SELECT-then-INSERT races, no application-level mutex — the database handles it atomically.

## Implications

- Dedup keys must be deterministic — parameter ordering must be normalized (sorted keys) to avoid false negatives
- The dedup window is implicit: tasks remain deduped until completed and cleaned up. A TTL or status-based cleanup is needed to allow re-creation of previously completed tasks
- Callers must check the `created` flag and handle the "lost race" case gracefully (typically a no-op)
- Compound keys can grow large with complex params — consider hashing for very large parameter sets
- This pattern handles creation-time dedup only; it does not prevent duplicate execution if a task is picked up twice (see distributed job locking for that)

## Code Example

```javascript
// Webhook handler that may fire multiple times
async function handleDependencyAlert(webhook) {
  const { created, taskId } = await createTaskIfNew(db, {
    type: 'dependency-update',
    params: { repo: webhook.repo, package: webhook.package, version: webhook.version },
    metadata: { source: 'webhook', receivedAt: Date.now() },
  });

  if (!created) {
    logger.info('Duplicate task suppressed', { type: 'dependency-update', repo: webhook.repo });
    return;
  }

  logger.info('Task created', { taskId });
  await jobQueue.enqueue(taskId);
}
```

## Related Patterns

- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
- [Distributed Job Locking](./distributed-job-locking.md)
