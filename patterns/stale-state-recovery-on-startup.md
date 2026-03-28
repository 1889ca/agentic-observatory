# Stale State Recovery on Startup

> Redis TTL-based lock cleanup that clears immortal locks (keys with no expiry) on startup and via periodic sweep, with local lock map reset — no PID-based DB lock checks or bulk task resets.

## Problem

When a process crashes or is killed, in-flight work is frozen mid-execution. Redis-backed job locks may survive the crash if they were set without an expiry (due to a Redis failover bug or SET command anomaly). On the next start, these "immortal" locks block job execution indefinitely — the lock key exists but no process holds it, and without a TTL, it never expires. The system needs a startup cleanup that detects and removes these orphaned locks without accidentally clearing locks held by other live instances.

## Context

- A Node.js orchestrator using Redis for distributed job locking via SET NX with PX (millisecond TTL)
- Normal lock lifecycle: acquired with TTL → released on job completion → or expires naturally on crash
- The pathological case: a Redis key loses its TTL (failover, SET bug), becoming permanent
- Multiple instances may run concurrently — startup cleanup must not clear locks held by another live instance
- Job locks use a prefix (`riley:job-lock:`) and store a token value (`instanceId:jobName:timestamp:random`)

## Solution

### Local Lock Map Reset

On startup, the in-memory lock map is cleared unconditionally. Any local state from a previous incarnation of this process is invalid:

```javascript
// lib/job-lock.js
async function clearStaleOnStartup() {
  locks.clear()  // Reset local Map — previous process state is gone

  if (!redis.isEnabled()) return 0

  // ... Redis cleanup follows
}
```

### Immortal Lock Detection and Cleanup

The startup function scans all keys matching the lock prefix and checks their TTL. Only keys with `pTTL === -1` (key exists but has no expiry) are removed. Keys with a positive TTL are left alone — they are either held by a live instance or will expire naturally:

```javascript
// lib/job-lock.js
const LOCK_PREFIX = process.env.JOB_LOCK_PREFIX || 'riley:job-lock:'

async function clearStaleOnStartup() {
  locks.clear()

  if (!redis.isEnabled()) return 0

  try {
    const client = await redis.getClient()
    if (!client) return 0

    const keys = await client.keys(`${LOCK_PREFIX}*`)
    if (keys.length === 0) return 0

    // Only clear keys that have no TTL (immortal)
    const toClear = []
    for (const key of keys) {
      const ttl = await client.pTTL(key)
      if (ttl === -1) toClear.push(key)
    }

    if (toClear.length === 0) return 0

    await client.del(toClear)
    logger.info({ cleared: toClear.length }, 'Cleared immortal Redis lock(s) on startup')
    return toClear.length
  } catch (err) {
    logger.warn({ err }, 'Failed to clear stale Redis locks on startup')
    return 0
  }
}
```

The key insight: `pTTL` returns `-1` for keys that exist but have no expiry, `-2` for keys that do not exist, and a positive number for keys with a valid TTL. Only `-1` indicates a stuck lock.

### Inline Immortal Lock Detection During Acquisition

The same immortal lock detection runs during normal lock acquisition. If a `SET NX` fails because the key exists, the code checks the TTL. If it is `-1`, the lock is force-cleared and acquisition is retried:

```javascript
// lib/job-lock.js
async function tryAcquire(jobName, options = {}) {
  const timeout = getJobTimeout(jobName)
  const token = `${INSTANCE_ID}:${jobName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const key = `${LOCK_PREFIX}${jobName}`

  const result = await client.set(key, token, { NX: true, PX: timeout })
  if (result === 'OK') {
    locks.set(jobName, { acquiredAt: Date.now(), timeout, token, distributed: true })
    return { acquired: true, distributed: true }
  }

  // SET NX failed — check for immortal lock
  const ttl = await client.pTTL(key)
  if (ttl === -1) {
    logger.warn({ jobName }, 'Immortal Redis lock detected (no TTL), clearing')
    await client.del(key)
    // Retry acquisition
    const retry = await client.set(key, token, { NX: true, PX: timeout })
    if (retry === 'OK') {
      locks.set(jobName, { acquiredAt: Date.now(), timeout, token, distributed: true })
      return { acquired: true, distributed: true }
    }
  }

  return { acquired: false, reason: 'already_locked', redisTTL: ttl }
}
```

### Periodic Sweep

A background sweep runs every 5 minutes to catch immortal locks that appear after startup (e.g., due to a Redis failover mid-operation):

```javascript
// lib/job-lock.js
async function sweepStaleLocks() {
  if (!redis.isEnabled()) return 0

  const client = await redis.getClient()
  if (!client) return 0

  const keys = await client.keys(`${LOCK_PREFIX}*`)
  let cleared = 0

  for (const key of keys) {
    const ttl = await client.pTTL(key)
    if (ttl === -1) {
      logger.warn({ key }, 'Sweep: clearing immortal Redis lock')
      await client.del(key)
      cleared++
    }
  }

  if (cleared > 0) logger.info({ cleared }, 'Sweep cleared immortal Redis lock(s)')
  return cleared
}

function startSweep() {
  const interval = setInterval(sweepStaleLocks, 5 * 60 * 1000)
  // Also run once 30 seconds after startup for post-deploy stragglers
  setTimeout(sweepStaleLocks, 30_000)
}
```

### Safe Release with Token Verification

Lock release uses a Lua script to atomically verify the token before deletion — this prevents one instance from accidentally releasing another instance's lock:

```javascript
// lib/job-lock.js
async function release(jobName) {
  const lock = locks.get(jobName)
  if (!lock) return { released: false, reason: 'not_locked' }

  locks.delete(jobName)

  if (redis.isEnabled() && lock.token) {
    const key = `${LOCK_PREFIX}${jobName}`
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `
    await client.eval(script, { keys: [key], arguments: [lock.token] })
  }

  return { released: true, duration: Date.now() - lock.acquiredAt }
}
```

### Job-Specific Timeouts

Each job type has a configured timeout that becomes the Redis key's PX value. Long-running jobs get longer timeouts to avoid premature expiry:

```javascript
// lib/job-lock.js
const JOB_TIMEOUTS = {
  'self-improve':       45 * 60 * 1000,
  'issue-solver':       45 * 60 * 1000,
  'autonomous-agent':   30 * 60 * 1000,
  'daily-reflection':   15 * 60 * 1000,
  'free-time':          60 * 60 * 1000,
  'email-triage':        5 * 60 * 1000,
  'reminders':              60 * 1000,
  'template-scheduler':     60 * 1000,
  'outbound-processor':     60 * 1000,
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
```

### Expired Lock Notification

When a local lock is found expired during acquisition (job ran past its timeout), the system sends a notification to alert operators:

```javascript
// lib/job-lock.js
function handleExpiredLock(jobName, existingLock) {
  const durationMinutes = Math.round((Date.now() - existingLock.acquiredAt) / 60000)
  const timeoutMinutes = Math.round(existingLock.timeout / 60000)

  audit.log('job-lock:expired', { job: jobName, duration: Date.now() - existingLock.acquiredAt })

  messenger.forSource('system').notification('warning',
    `Job "${jobName}" force-terminated after ${durationMinutes}m (timeout: ${timeoutMinutes}m)`,
    { hint: 'Job may have stalled or crashed. Check logs for errors.' }
  )

  locks.delete(jobName)
}
```

## Implications

- TTL-based cleanup is conservative — it only removes provably orphaned locks (no TTL), never locks that might be held by a live instance
- No PID-based checks means the system works across containers and hosts where PID reuse is meaningless
- No bulk task reset on startup — tasks in `running` state are handled by individual task timeout mechanisms, not by a startup sweep
- The periodic sweep catches edge cases where a lock loses its TTL mid-operation (rare but possible during Redis failover)
- `KEYS` command is used for lock scanning — acceptable because the lock keyspace is small (tens of keys), but would need `SCAN` if lock cardinality grew significantly
- The 30-second post-startup sweep catches locks that appeared between the startup sweep and the first periodic sweep
- Token-verified release prevents the classic distributed lock bug where instance A releases instance B's lock after A's lock expired and B re-acquired it

## Code Example

```javascript
// Startup sequence in index.js
const jobLock = require('./lib/job-lock')

async function bootstrap() {
  await db.connect()
  await redis.getClient()

  // Clear any immortal locks from previous crash
  const cleared = await jobLock.clearStaleOnStartup()
  if (cleared > 0) logger.info({ cleared }, 'Startup: cleared stale locks')

  // Start periodic sweep
  jobLock.startSweep()

  // Normal lock usage in jobs
  const lock = await jobLock.tryAcquire('email-triage')
  if (!lock.acquired) {
    logger.info({ reason: lock.reason }, 'Skipping email-triage: locked')
    return
  }

  try {
    await runEmailTriage()
  } finally {
    await jobLock.release('email-triage')
  }
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Redis Optional Caching and Clustering](./redis-optional-caching-and-clustering.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
