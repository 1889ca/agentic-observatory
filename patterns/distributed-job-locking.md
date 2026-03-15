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

Different jobs have different expected durations. Lock timeouts are configured per job type to prevent both premature expiration and indefinite holds:

```javascript
const JOB_TIMEOUTS = {
  'morning-review':       60 * 60 * 1000,   // 60 min — complex analysis
  'dependency-check':     30 * 60 * 1000,   // 30 min
  'health-scan':          10 * 60 * 1000,   // 10 min — quick check
  'learning-cycle':       20 * 60 * 1000,   // 20 min
  'cognitive-tick':       5 * 60 * 1000,    // 5 min — fast tick
  default:                30 * 60 * 1000,   // 30 min fallback
};

function getTimeout(jobName) {
  return JOB_TIMEOUTS[jobName] || JOB_TIMEOUTS.default;
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

### Graceful Degradation

When Redis is unavailable, the system falls back to in-memory locks. This provides single-instance safety without external dependencies:

```javascript
function acquireLocal(jobName, token, timeout) {
  const existing = localLocks.get(jobName);

  if (existing && Date.now() < existing.expiresAt) {
    return null; // Lock held
  }

  // Expired or doesn't exist — acquire
  localLocks.set(jobName, { token, expiresAt: Date.now() + timeout });
  return token;
}
```

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
- Per-job timeouts require maintenance — adding a new job type may need a timeout entry
- The expiration sweep runs on an interval, so there's a window (up to 5 minutes) where an expired lock isn't yet cleaned up
- No lock queuing — if a lock is held, the caller gets `null` immediately. Retry logic is the caller's responsibility

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
