# Distributed Job Locking

> Redis-backed mutex with in-memory fallback, per-job timeout configurations, and token-based ownership for preventing concurrent execution of the same job.

## Problem

In an orchestrator that schedules and dispatches jobs, the same job can be triggered concurrently — by a cron schedule firing while a previous run is still active, by a manual trigger overlapping with an automatic one, or by multiple orchestrator instances sharing a queue. Without distributed locking, two instances of the same job can run simultaneously, causing data corruption, duplicate actions, or wasted compute.

## Context

- An orchestrator running scheduled and on-demand jobs that must not overlap
- Multiple processes or instances may attempt to run the same job
- Different job types have different expected durations (10 minutes to 1 hour)
- Redis may not always be available — graceful degradation is required
- Lock ownership must be verifiable to prevent accidental release by the wrong process

## Solution

### Token-Based Lock Acquisition

Each lock is identified by job name and owned by a unique token. The token combines instance ID, job name, timestamp, and a random suffix — making accidental collision effectively impossible:

```javascript
// job-lock.js
const INSTANCE_ID = `${hostname()}-${process.pid}`;

async function acquire(jobName) {
  const timeout = getTimeout(jobName);
  const token = `${INSTANCE_ID}:${jobName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const key = `${LOCK_PREFIX}${jobName}`;

  // Try Redis first
  if (redis.isEnabled()) {
    const result = await redis.set(key, token, { NX: true, PX: timeout });
    if (result === 'OK') {
      localLocks.set(jobName, { token, expiresAt: Date.now() + timeout });
      return token;
    }
    return null; // Lock held by another process
  }

  // Fallback: in-memory lock (single-instance only)
  return acquireLocal(jobName, token, timeout);
}
```

### Per-Job Timeout Configuration

Different jobs have different expected durations. Lock timeouts are configured per job type to prevent both premature expiration and indefinite holds. The default is intentionally conservative (10 minutes) — anything that needs longer must opt in explicitly:

```javascript
// Default timeout: 10 minutes (most jobs should complete faster)
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const JOB_TIMEOUTS = {
  // Long-running cognitive work
  'self-improve':        45 * 60 * 1000,
  'issue-solver':        45 * 60 * 1000,
  'autonomous-agent':    30 * 60 * 1000,
  'riley-work':          30 * 60 * 1000,
  'free-time':           60 * 60 * 1000,   // exploratory
  'daily-reflection':    15 * 60 * 1000,

  // Standard jobs
  'morning':             10 * 60 * 1000,
  'weekly-digest':       10 * 60 * 1000,

  // Quick jobs — sub-minute is fine
  'reminders':                60 * 1000,
  'cc-budget':                60 * 1000,
  'email-triage':         5 * 60 * 1000,
  'sync-github-issues':   5 * 60 * 1000,
  'sync-calendar':        5 * 60 * 1000,

  // Schedulers/processors — short timeout so a crash doesn't block scheduling
  'template-scheduler':       60 * 1000,
  'outbound-processor':       60 * 1000,
}

function getJobTimeout(jobName) {
  return JOB_TIMEOUTS[jobName] || DEFAULT_TIMEOUT_MS
}
```

### Token-Verified Release

Only the process that acquired the lock can release it. The token is checked before deletion to prevent one process from releasing another's lock:

```javascript
async function release(jobName, token) {
  const key = `${LOCK_PREFIX}${jobName}`;

  if (redis.isEnabled()) {
    // Atomic check-and-delete via Lua script
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, key, token);
  }

  // Always clean up local state
  const local = localLocks.get(jobName);
  if (local?.token === token) {
    localLocks.delete(jobName);
  }
}
```

### Expiration Sweep

A periodic sweep detects locks that have exceeded their timeout (process crashed without releasing), clears them, and optionally notifies:

```javascript
// Runs every 5 minutes
async function sweepExpiredLocks() {
  for (const [jobName, lock] of localLocks) {
    if (Date.now() > lock.expiresAt) {
      logger.warn({ jobName, token: lock.token }, 'Lock expired — releasing');
      localLocks.delete(jobName);

      if (redis.isEnabled()) {
        // Only delete if Redis still holds our token (not re-acquired by another)
        await release(jobName, lock.token);
      }

      // Notify about potential stuck job
      messenger?.send(`Lock expired for job: ${jobName}`).catch(() => {});
    }
  }
}
```

### Graceful Degradation with Opt-Out

When Redis is unavailable, the system falls back to in-memory locks for single-instance safety. Critical jobs can refuse the fallback via `requireDistributed: true` — if Redis is down, the acquisition fails rather than risking a duplicate run across instances:

```javascript
async function tryAcquire(jobName, options = {}) {
  const { requireDistributed = false } = options
  const timeout = getJobTimeout(jobName)

  if (redis.isEnabled()) {
    // ... Redis SET NX PX path
  }

  if (requireDistributed) {
    return { acquired: false, reason: 'distributed-required' }
  }

  // Local fallback — single-instance only
  return acquireLocal(jobName, timeout)
}
```

### Immortal Lock Detection

A lock with TTL = -1 (no expiry) is a bug — usually a Redis SET that lost its PX. The system detects these on startup and during the periodic sweep, then force-clears them so the next acquisition can proceed:

```javascript
async function sweepImmortalLocks() {
  const keys = await redis.keys(`${LOCK_PREFIX}*`)
  for (const key of keys) {
    const ttl = await redis.ttl(key)
    if (ttl === -1) {
      logger.warn({ key }, 'Sweep: clearing immortal Redis lock')
      await redis.del(key)
    }
  }
}
```

Sweeping only immortal locks (rather than any "old-looking" lock) avoids racing with legitimately long jobs that still own their TTL.

### Lazy Messenger Initialization

The lock module needs to send notifications about expired locks, but the messenger may not be initialized yet at module load time. A lazy getter avoids circular dependency issues:

```javascript
let _messenger = null;

function getMessenger() {
  if (!_messenger) {
    _messenger = require('./messenger'); // Lazy load
  }
  return _messenger;
}
```

## Implications

- Redis `NX` (set-if-not-exists) provides atomic lock acquisition — no race conditions between check and set
- Token-based ownership prevents the "delete someone else's lock" problem that plagues simple key-based locking
- The Lua script for release is atomic — no window between reading and deleting where another process could interfere
- In-memory fallback means single-instance deployments don't need Redis at all
- Per-job timeouts require maintenance — adding a new job type may need a timeout entry; the 10-minute default is conservative on purpose
- The expiration sweep runs on an interval, so there's a window where an expired lock isn't yet cleaned up
- Immortal-lock sweeping only deletes TTL=-1 keys — long-running jobs with legitimate TTLs are never disturbed
- `requireDistributed: true` is the right setting for any job whose double-execution would corrupt data (financial postings, external API calls with side effects)
- No lock queuing — if a lock is held, the caller gets `acquired: false` immediately. Retry logic is the caller's responsibility

## Code Example

```javascript
// Usage: wrap job execution with lock acquisition and release
async function runScheduledJob(jobName, jobFn) {
  const token = await acquire(jobName);

  if (!token) {
    logger.info({ jobName }, 'Job already running, skipping');
    return { skipped: true };
  }

  try {
    const result = await jobFn();
    return result;
  } finally {
    await release(jobName, token);
  }
}

// Example: morning review job with 60-minute lock timeout
cron.schedule('0 9 * * *', async () => {
  await runScheduledJob('morning-review', async () => {
    // This code is guaranteed to run without overlap
    const report = await analyzeMorningActivity();
    await sendReport(report);
  });
});
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
