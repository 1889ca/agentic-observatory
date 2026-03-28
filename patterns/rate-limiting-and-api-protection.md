# Rate Limiting and API Protection

> In-memory timestamp-array rate limiter with standard and heavy endpoint tiers, burst detection, configurable window/max via environment, and automatic periodic cleanup.

## Problem

Without rate limiting, an API is vulnerable to both accidental and intentional abuse. A chatty client with a retry loop can saturate the server. A misconfigured webhook can fire hundreds of requests per second. Even well-meaning internal clients can cause cascading failures by hammering expensive endpoints during peak load. The server has no way to push back — it either processes every request or crashes trying.

## Context

- A Node.js API server exposing routes that serve both internal agents and external integrations
- Different endpoints have different cost profiles — a health check is cheap, a vector search or chat endpoint is expensive
- Clients are identified by IP address combined with tenant ID
- The system should communicate limits clearly via standard HTTP headers so clients can self-regulate
- Rate limiting uses in-memory storage only — no Redis dependency for this layer

## Solution

### Timestamp-Array Sliding Window

The rate limiter stores an array of request timestamps per client identifier. On each request, timestamps older than the window are pruned, and the array length is compared against the maximum. This is simpler than interpolated sliding windows — it tracks actual requests, not estimates:

```javascript
// lib/server/rate-limit.js
const limitStore = new Map()

function getEntry(identifier) {
  let entry = limitStore.get(identifier)
  if (!entry) {
    entry = { requests: [], windowStart: Date.now() }
    limitStore.set(identifier, entry)
  }
  return entry
}

function cleanEntry(entry, windowMs) {
  const cutoff = Date.now() - windowMs
  entry.requests = entry.requests.filter((r) => r.timestamp > cutoff)
}
```

### Standard vs. Heavy Endpoint Model

Rather than per-endpoint configuration maps, the limiter uses two tiers: standard and heavy. Heavy endpoints are explicitly listed — everything else gets standard limits:

```javascript
// lib/server/rate-limit.js
const HEAVY_ENDPOINTS = [
  '/api/search',
  '/api/context',
  '/api/embedding',
  '/api/documents/search',
  '/api/memory/search',
  '/api/chat',
]

function isHeavyEndpoint(path) {
  return HEAVY_ENDPOINTS.some((ep) => path.startsWith(ep))
}
```

Limits are configured via environment variables through the central config module: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_HEAVY_MAX`, and `RATE_LIMIT_BURST_MAX`.

### Burst Detection

In addition to the main window check, the limiter tracks a 5-second burst window. Even if a client is under the per-minute limit, sending too many requests in a 5-second burst triggers a 429:

```javascript
// lib/server/rate-limit.js
function checkBurst(entry) {
  const burstWindow = 5000 // 5 seconds
  const cutoff = Date.now() - burstWindow
  const recentRequests = entry.requests.filter((r) => r.timestamp > cutoff)
  return recentRequests.length
}
```

### Configurable Limiter Factory

The `createLimiter` factory produces middleware with configurable parameters. Two pre-built instances cover the common cases, and an `autoLimiter` selects between them based on the request path:

```javascript
// lib/server/rate-limit.js
function createLimiter(options = {}) {
  const windowMs = options.windowMs || RATE_LIMIT_WINDOW_MS
  const maxRequests = options.heavy
    ? RATE_LIMIT_HEAVY_MAX
    : (options.max || RATE_LIMIT_MAX_REQUESTS)
  const burstMax = options.burstMax || RATE_LIMIT_BURST_MAX

  return (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next()
    if (req.path === '/health' || req.path === '/health/role') return next()

    const identifier = getIdentifier(req)
    const entry = getEntry(identifier)
    cleanEntry(entry, windowMs)

    // Check window limit
    if (entry.requests.length >= maxRequests) {
      const retryAfter = Math.ceil(
        (entry.requests[0].timestamp + windowMs - Date.now()) / 1000
      )
      res.set('Retry-After', String(retryAfter))
      res.set('X-RateLimit-Limit', String(maxRequests))
      res.set('X-RateLimit-Remaining', '0')
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter,
        limit: maxRequests,
        window: windowMs / 1000,
      })
    }

    // Check burst limit
    if (checkBurst(entry) >= burstMax) {
      res.set('Retry-After', '5')
      return res.status(429).json({
        error: 'Burst limit exceeded',
        retryAfter: 5,
        burstLimit: burstMax,
      })
    }

    entry.requests.push({ timestamp: Date.now() })
    res.set('X-RateLimit-Limit', String(maxRequests))
    res.set('X-RateLimit-Remaining', String(maxRequests - entry.requests.length))
    next()
  }
}

const standardLimiter = createLimiter()
const heavyLimiter = createLimiter({ heavy: true })

function autoLimiter(req, res, next) {
  if (!RATE_LIMIT_ENABLED) return next()
  const limiter = isHeavyEndpoint(req.path) ? heavyLimiter : standardLimiter
  return limiter(req, res, next)
}
```

### Client Identification

Rate limit keys combine IP address and tenant ID, allowing per-tenant limits even when requests come from the same IP:

```javascript
// lib/server/rate-limit.js
function getIdentifier(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown'
  const tenantId = req.query?.tenantId || req.body?.tenantId || 'default'
  return `${ip}:${tenantId}`
}
```

### Periodic Cleanup

A background interval cleans up stale entries every 5 minutes to prevent unbounded memory growth. The interval is `unref()`-ed so it does not keep the process alive:

```javascript
// lib/server/rate-limit.js
const CLEANUP_INTERVAL = 5 * 60 * 1000

function startCleanup() {
  const interval = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2
    for (const [key, entry] of limitStore) {
      if (entry.requests.length === 0 ||
          entry.requests.every((r) => r.timestamp < cutoff)) {
        limitStore.delete(key)
      }
    }
  }, CLEANUP_INTERVAL)
  interval.unref?.()
}

startCleanup() // Starts on module load
```

### Monitoring

The module exposes stats for the ops metrics system:

```javascript
// lib/server/rate-limit.js
function getStats() {
  return {
    activeClients: limitStore.size,
    totalRequests: /* sum of all entry request counts */,
    heavyEndpointLimit: RATE_LIMIT_HEAVY_MAX,
    standardLimit: RATE_LIMIT_MAX_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  }
}
```

## Implications

- The timestamp-array approach is exact, not estimated — there is no interpolation error at window boundaries, but memory usage scales linearly with request rate per client
- Two tiers (standard/heavy) is simpler than per-endpoint configuration but less granular — adding a new expensive endpoint means adding it to the `HEAVY_ENDPOINTS` array
- In-memory storage means rate limits are per-instance — a client hitting different instances behind a load balancer gets N times the limit. This is acceptable for the current deployment model.
- Health check endpoints are explicitly excluded to prevent load balancer probes from consuming rate limit budget
- Burst detection catches abusive patterns that stay under the per-minute limit — a client sending 50 requests in 1 second would hit the burst limit even if the per-minute limit is 100
- The `RATE_LIMIT_ENABLED` flag allows disabling rate limiting entirely in development or testing
- Standard HTTP headers (`X-RateLimit-*`, `Retry-After`) let well-behaved clients self-regulate

## Code Example

```javascript
// Applying the auto-limiter to all API routes
const { autoLimiter } = require('./rate-limit')
app.use('/api', autoLimiter)

// Custom limiter for a specific route
const { createLimiter } = require('./rate-limit')
const strictLimiter = createLimiter({ max: 5, windowMs: 60000, burstMax: 3 })
app.post('/api/deploy', strictLimiter, deployHandler)

// Monitoring integration
const { getStats } = require('./rate-limit')
// getStats() returns: { activeClients: 12, totalRequests: 847, ... }
```

## Related Patterns

- [Redis Optional Caching and Clustering](./redis-optional-caching-and-clustering.md)
- [Ops Metrics and Health Monitoring](./ops-metrics-and-health-monitoring.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
