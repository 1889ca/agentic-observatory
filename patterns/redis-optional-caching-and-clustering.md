# Redis Optional Caching and Clustering

> Optional Redis integration that reads `REDIS_URL` directly, uses the `redis` client's built-in reconnect strategy with exponential backoff, and exposes a lazy singleton client — no in-memory fallback cache, no host/port assembly.

## Problem

Redis is extremely useful for caching, pub/sub, and distributed coordination — but making it a hard dependency creates fragility. If Redis goes down, the entire application goes down. If Redis is slow to start, the application hangs on boot. In development, requiring Redis running locally adds friction to onboarding. The system needs Redis when it's available, but must survive without it.

## Context

- A Node.js orchestrator that benefits from Redis for caching, distributed job locking, and Socket.io pub/sub
- Multiple instances may run behind a load balancer, needing coordinated state
- Redis availability varies across environments — always present in production, often absent in local development
- Some features degrade without Redis (distributed locks become local-only) but the core system must keep running
- Redis outages should be recoverable without application restarts

## Solution

### Simple URL-Based Configuration

The Redis module checks a single environment variable. No host/port/password assembly — just `REDIS_URL` or nothing:

```javascript
// lib/redis.js
const { createClient } = require('redis')
const logger = require('./logger').child({ module: 'redis' })

let client = null
let initPromise = null

const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY = 1000   // 1 second
const MAX_RECONNECT_DELAY = 30000   // 30 seconds

function getRedisUrl() {
  return process.env.REDIS_URL || null
}

function isEnabled() {
  return !!getRedisUrl()
}
```

If `REDIS_URL` is not set, `isEnabled()` returns false and `getClient()` returns null. Every consumer checks this before attempting Redis operations.

### Lazy Singleton with Built-In Reconnect

The client is created on first use and reused for all subsequent calls. Reconnection is handled by the `redis` client's own `reconnectStrategy` socket option — no custom `scheduleReconnect` function:

```javascript
// lib/redis.js
async function getClient() {
  const url = getRedisUrl()
  if (!url) return null

  // Return existing healthy client
  if (client && client.isOpen) return client

  // Return in-flight connection attempt
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      client = createClient({
        url,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > MAX_RECONNECT_ATTEMPTS) {
              logger.error({ retries }, 'Max reconnection attempts reached')
              return false // Stop reconnecting
            }
            const delay = Math.min(
              BASE_RECONNECT_DELAY * Math.pow(2, retries),
              MAX_RECONNECT_DELAY
            )
            logger.warn({ delayMs: delay, attempt: retries + 1 }, 'Reconnecting')
            return delay
          },
        },
      })

      client.on('error', (err) => logger.error({ err }, 'Client error'))
      client.on('ready', () => logger.info('Connected and ready'))
      client.on('end', () => logger.warn('Connection closed'))

      await client.connect()
      logger.info('Initial connection established')
      return client
    } catch (err) {
      logger.error({ err }, 'Initial connection failed')
      client = null
      initPromise = null
      throw err
    } finally {
      initPromise = null
    }
  })()

  return initPromise
}
```

The `initPromise` guard prevents multiple concurrent initialization attempts — if two callers hit `getClient()` simultaneously, both await the same connection.

### Client Duplication for Pub/Sub

Some consumers need dedicated connections (e.g., Socket.io pub/sub requires separate publish and subscribe clients). The module exposes a `duplicateClient()` helper:

```javascript
// lib/redis.js
async function duplicateClient() {
  const base = await getClient()
  if (!base) return null
  const dup = base.duplicate()
  dup.on('error', (err) => logger.error({ err }, 'Duplicate client error'))
  await dup.connect()
  return dup
}
```

### Separate Cache Layer

The caching API lives in a separate `lib/cache.js` module that composes Redis, not extends it. It adds key prefixing, JSON serialization, TTL management, and prefix-based deletion:

```javascript
// lib/cache.js
const redis = require('./redis')
const { CACHE_ENABLED, CACHE_TTL_SECONDS } = require('./config')

const PREFIX = process.env.RILEY_CACHE_PREFIX || 'riley:cache:'

function isEnabled() {
  return CACHE_ENABLED !== false && redis.isEnabled()
}

async function getJson(key) {
  const client = await getClient()
  if (!client) return null
  try {
    const raw = await client.get(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function setJson(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  const client = await getClient()
  if (!client) return false
  try {
    const payload = JSON.stringify(value)
    if (ttlSeconds > 0) {
      await client.setEx(key, ttlSeconds, payload)
    } else {
      await client.set(key, payload)
    }
    return true
  } catch { return false }
}

async function delPrefix(prefix) {
  const client = await getClient()
  if (!client) return 0
  let deleted = 0
  for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    deleted += await client.del(key)
  }
  return deleted
}
```

When Redis is unavailable, every cache operation returns null/false — no in-memory fallback Map. Callers that need local caching use a separate `TTLCache` utility (`lib/utils/ttl-cache.js`) explicitly.

### Graceful Disconnect

The module provides a clean shutdown path for the server shutdown sequence:

```javascript
// lib/redis.js
async function disconnect() {
  if (client && client.isOpen) {
    try {
      await client.quit()
      logger.info('Disconnected gracefully')
    } catch (err) {
      logger.warn({ err }, 'Error during disconnect')
    }
  }
  client = null
  initPromise = null
}
```

## Implications

- No in-memory fallback means cache misses are silent when Redis is down — callers must handle null returns naturally, which they already do for normal cache misses
- The `reconnectStrategy` callback is the single point of reconnection policy — no separate reconnect scheduling, no event-driven retry loops
- `REDIS_URL` as the only config surface means no accidental misconfiguration from partial host/port/password combinations
- Client duplication for pub/sub creates additional connections — in production this is fine, but connection limits should account for duplicates
- The cache module's `delPrefix` uses `SCAN` iteration, which is safe for production (no `KEYS *` blocking) but may be slow for very large keyspaces
- Redis is not required for the application to start or run — it is a pure enhancement layer for caching and distributed coordination

## Code Example

```javascript
// Usage: a module that caches expensive computations
const cache = require('../cache')

const CACHE_TTL = 300 // 5 minutes

async function getProjectSummary(projectId) {
  const cacheKey = cache.buildKey(['project', 'summary', projectId])

  // Try cache first — returns null if Redis unavailable or miss
  const cached = await cache.getJson(cacheKey)
  if (cached) return cached

  // Compute expensive result
  const summary = await computeProjectSummary(projectId)

  // Cache for next time — no-op if Redis unavailable
  await cache.setJson(cacheKey, summary, CACHE_TTL)

  return summary
}

// Invalidate all project caches
async function invalidateProjectCaches(projectId) {
  const prefix = cache.buildPrefix(['project', 'summary', projectId])
  await cache.delPrefix(prefix)
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Stale State Recovery on Startup](./stale-state-recovery-on-startup.md)
