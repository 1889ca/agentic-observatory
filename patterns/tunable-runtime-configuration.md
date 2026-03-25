# Tunable Runtime Configuration

> DB-backed parameters that can be adjusted at runtime without restarting the process.

## Problem

Operational systems need adjustable knobs — tick intervals, batch sizes, rate limits, feature flags — but static config (env vars, config files) requires a process restart to change. User settings are per-user and inappropriate for system-wide concerns. Without a third tier, operators are stuck choosing between risky restarts and hardcoded defaults that can't respond to real-world conditions.

## Context

Applies to long-running agentic or server processes where:
- Some parameters need live adjustment during operation (e.g., slowing a cognitive loop under load)
- Downtime from restarts is unacceptable or disruptive
- The values need to persist across restarts (not just in-process state)
- Changes must take effect system-wide, not per-user

## Solution

A dedicated tunables layer sits between static config and user settings, backed by a database table. On startup, the system performs a warm-up phase: all tunables are read from the DB and loaded into an in-memory cache. After warm-up, all reads hit the cache — no per-request DB round-trips. Updates (via API or admin interface) write to the DB and invalidate or refresh the cache, making changes live without restarting.

**Three-tier config hierarchy:**

| Tier | Backed By | Adjustable Without Restart | Scope |
|---|---|---|---|
| Static config | Env vars / files | No | Process |
| Tunables | Database | Yes | System-wide |
| User settings | Database | Yes | Per-user |

Each tunable record carries: `key`, `value`, `type` (`number` / `string` / `boolean`), `default`, and `description`.

The warm-up phase (called before the system begins processing) ensures every tunable is cache-resident — eliminating cold-read latency on first access and making the cache the single authoritative source during normal operation.

Implementation lives in `lib/config/tunables/`.

## Implications

- Warm-up adds a small startup cost; it must complete before processing begins
- Cache invalidation strategy matters — a missed flush means stale values until next restart
- Tunables are not a replacement for user settings; mixing the two creates confusing ownership
- The DB becomes a dependency for startup; handle unavailability via [Graceful Degradation](./graceful-degradation-and-optional-init.md)
- Audit logging on tunable changes is advisable in production

## Code Example

```js
// lib/config/tunables/index.js
const cache = new Map();

export async function warmUp(db) {
  const rows = await db.query('SELECT key, value, type FROM tunables');
  for (const row of rows) {
    cache.set(row.key, coerce(row.value, row.type));
  }
}

export function get(key, fallback) {
  return cache.has(key) ? cache.get(key) : fallback;
}

export async function set(db, key, value) {
  await db.query(
    'UPDATE tunables SET value = $1 WHERE key = $2',
    [String(value), key]
  );
  const row = await db.query('SELECT type FROM tunables WHERE key = $1', [key]);
  cache.set(key, coerce(String(value), row[0].type));
}

function coerce(value, type) {
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

// Startup
await warmUp(db);
await startProcessingLoop(); // tunables are cache-hot before first tick

// Runtime read (no DB hit)
const batchSize = get('embedding_batch_size', 32);
const tickMs = get('cognitive_tick_interval_ms', 1000);
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Database Abstraction and Schema Management](./database-abstraction-and-schema-management.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
