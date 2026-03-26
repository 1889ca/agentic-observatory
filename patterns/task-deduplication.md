# Task Deduplication

> Inline deduplication within task creation flows using compound unique indexes and atomic INSERT ON CONFLICT resolution.

## Problem

Multiple agents or triggers can independently decide the same work needs doing — a webhook fires twice, two satellites notice the same stale dependency, a retry races with a fresh dispatch. Without deduplication, the system performs redundant work, wastes compute, and can produce conflicting results when two agents modify the same resource concurrently.

## Context

- Multiple producers (agents, webhooks, schedules) can create tasks independently
- Race conditions between concurrent task creators are common
- Tasks are identified by a combination of type and parameters
- The system needs to know which creator "won" the race to avoid duplicate execution
- Database-level guarantees are preferred over application-level locking

## Solution

Deduplication is embedded directly within task creation routines rather than existing as a standalone module. Each task creation flow constructs a compound key from the task type and parameters, then uses `INSERT ... ON CONFLICT DO NOTHING` to atomically prevent duplicates at the database level.

```javascript
// Within a task creation routine — dedup is inline, not a separate module
async function createTask(db, { type, params, metadata }) {
  // Dedup key is built inline from type + sorted params
  const stable = JSON.stringify(params, Object.keys(params).sort());
  const dedupKey = `${type}:${stable}`;

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
```

The compound index on `dedup_key` ensures that even under heavy concurrency, only one row is inserted for a given type+params combination. There is no standalone deduplication module or separate `buildDedupKey()` utility — the key construction and conflict resolution are co-located with the insert logic in whatever routine creates the task. This keeps the dedup concern close to where it matters and avoids an abstraction that would need to be wired into every creation path.

## Implications

- Dedup keys must be deterministic — parameter ordering must be normalized (sorted keys) to avoid false negatives
- The dedup window is implicit: tasks remain deduped until completed and cleaned up. A TTL or status-based cleanup is needed to allow re-creation of previously completed tasks
- Callers must check the `created` flag and handle the "lost race" case gracefully (typically a no-op)
- Compound keys can grow large with complex params — consider hashing for very large parameter sets
- Because dedup logic is inline, any new task creation path must remember to include the ON CONFLICT clause — there is no centralized enforcement point
- This pattern handles creation-time dedup only; it does not prevent duplicate execution if a task is picked up twice (see distributed job locking for that)

## Code Example

```javascript
// Webhook handler that may fire multiple times
async function handleDependencyAlert(webhook) {
  const { created, taskId } = await createTask(db, {
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
