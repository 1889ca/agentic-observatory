# Rate Limiting and API Protection

> Auto-applied sliding window rate limiter on `/api/*` routes with per-endpoint configurable thresholds, custom key extraction, and Redis-backed or in-memory storage.

## Problem

Without rate limiting, an API is vulnerable to both accidental and intentional abuse. A chatty client with a retry loop can saturate the server. A misconfigured webhook can fire hundreds of requests per second. An attacker can brute-force authentication endpoints. Even well-meaning internal clients can cause cascading failures by hammering expensive endpoints during peak load. The server has no way to push back — it either processes every request or crashes trying.

## Context

- A Node.js API server exposing `/api/*` routes that serve both internal agents and external integrations
- Different endpoints have different cost profiles — a health check is cheap, a full analysis endpoint is expensive
- Clients may be identified by IP address, API key, or authenticated user ID
- Redis may or may not be available — rate limiting must work in both cases
- The system should communicate limits clearly via standard HTTP headers so clients can self-regulate
- Rate limiting applies automatically to all API routes without requiring per-route opt-in

## Solution

### Sliding Window Counter

The rate limiter uses a sliding window algorithm. Each request increments a counter keyed by the client identifier and the current time window. The window slides by tracking requests in both the current and previous window, interpolating the count:

```typescript
// lib/server/rate-limit.ts
interface WindowState {
  count: number;
  windowStart: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

function checkSlidingWindow(
  current: WindowState,
  previous: WindowState,
  windowMs: number,
  maxRequests: number
): RateLimitResult {
  const now = Date.now();
  const windowElapsed = now - current.windowStart;
  const windowFraction = windowElapsed / windowMs;

  // Weighted count: full current window + proportional previous window
  const estimatedCount =
    current.count + previous.count * (1 - windowFraction);

  const resetAt = current.windowStart + windowMs;

  if (estimatedCount >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, Math.floor(maxRequests - estimatedCount - 1)),
    resetAt,
  };
}
```

### Per-Endpoint Configuration

Each endpoint can specify its own limits. Unconfigured endpoints fall back to sensible defaults. Configuration is declarative:

```typescript
interface EndpointLimit {
  maxRequests: number;
  windowMs: number;
  keyExtractor?: (req: Request) => string;
}

const ENDPOINT_LIMITS: Record<string, EndpointLimit> = {
  'POST /api/message': {
    maxRequests: 30,
    windowMs: 60_000,       // 30 per minute
  },
  'POST /api/flows': {
    maxRequests: 5,
    windowMs: 60_000,       // 5 per minute — expensive operation
  },
  'GET /api/health': {
    maxRequests: 120,
    windowMs: 60_000,       // 120 per minute — cheap, called often
  },
  'POST /api/hivemind': {
    maxRequests: 3,
    windowMs: 300_000,      // 3 per 5 minutes — very expensive
    keyExtractor: (req) => req.headers['x-api-key'] as string || getClientIp(req),
  },
};

const DEFAULT_LIMIT: EndpointLimit = {
  maxRequests: 60,
  windowMs: 60_000,         // 60 per minute default
};

function getLimitConfig(method: string, path: string): EndpointLimit {
  // Try exact match first
  const exact = ENDPOINT_LIMITS[`${method} ${path}`];
  if (exact) return exact;

  // Try pattern match (e.g., 'GET /api/tasks/:id' matches 'GET /api/tasks/abc')
  for (const [pattern, config] of Object.entries(ENDPOINT_LIMITS)) {
    const [patternMethod, patternPath] = pattern.split(' ');
    if (patternMethod === method && matchRoute(patternPath, path)) {
      return config;
    }
  }

  return DEFAULT_LIMIT;
}
```

### Key Extraction

The rate limit key determines what "identity" is being limited. Different endpoints may use different keys — IP address for unauthenticated routes, API key for authenticated ones:

```typescript
function defaultKeyExtractor(req: Request): string {
  // Prefer API key if present
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey) return `key:${apiKey}`;

  // Fall back to IP
  return `ip:${getClientIp(req)}`;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
```

### Storage Backend: Redis or In-Memory

The limiter uses Redis when available for distributed rate limiting across instances, falling back to an in-memory store for single-instance deployments:

```typescript
import { cacheGet, cacheSet, isEnabled as redisEnabled } from '../redis';

const localWindows = new Map<string, WindowState>();

async function getWindow(key: string): Promise<WindowState> {
  if (redisEnabled()) {
    const data = await cacheGet(key);
    if (data) return JSON.parse(data);
  } else {
    const local = localWindows.get(key);
    if (local) return local;
  }

  return { count: 0, windowStart: Date.now() };
}

async function saveWindow(key: string, state: WindowState, ttlMs: number): Promise<void> {
  if (redisEnabled()) {
    await cacheSet(key, JSON.stringify(state), ttlMs);
  } else {
    localWindows.set(key, state);
  }
}
```

### Middleware Application

The rate limiter attaches as Express middleware to all `/api/*` routes. It runs before route handlers, rejecting over-limit requests early:

```typescript
function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = getLimitConfig(req.method, req.path);
  const keyExtractor = config.keyExtractor || defaultKeyExtractor;
  const clientKey = keyExtractor(req);
  const windowKey = `ratelimit:${req.method}:${req.path}:${clientKey}`;

  processRateLimit(windowKey, config)
    .then((result) => {
      // Always set rate limit headers
      res.set('X-RateLimit-Limit', String(config.maxRequests));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: result.retryAfter,
          message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
        });
        return;
      }

      next();
    })
    .catch((err) => {
      // Rate limiter failure should not block requests
      logger.warn({ err }, 'Rate limiter error — allowing request');
      next();
    });
}

// Auto-apply to all API routes
app.use('/api/*', rateLimitMiddleware);
```

### In-Memory Cleanup

Without periodic cleanup, the in-memory store grows unbounded. A sweep removes expired windows:

```typescript
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, state] of localWindows) {
    // Remove windows older than 2x the largest configured window
    if (now - state.windowStart > 600_000) {
      localWindows.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug({ cleaned, remaining: localWindows.size }, 'Rate limit window cleanup');
  }
}, 300_000); // Every 5 minutes
```

## Implications

- Auto-application means new API routes get rate limiting by default — no developer can forget to add it
- The sliding window avoids the "burst at window boundary" problem that fixed windows have (where a client sends max requests at the end of one window and the start of the next)
- Per-endpoint configuration requires maintenance — adding a new expensive endpoint means adding a limit entry
- In-memory storage means rate limits are per-instance, not global — a client hitting different instances gets N times the limit. Redis fixes this.
- The fail-open design (allowing requests when the rate limiter errors) prioritizes availability over protection — acceptable for most internal APIs, may need reconsideration for public-facing ones
- Standard HTTP headers (`X-RateLimit-*`, `Retry-After`) let well-behaved clients self-regulate without parsing response bodies
- Key extraction by IP can be inaccurate behind shared proxies or NAT — API key-based limiting is more precise for authenticated endpoints

## Code Example

```typescript
// Adding a custom limit for a new expensive endpoint
ENDPOINT_LIMITS['POST /api/satellite/deploy'] = {
  maxRequests: 2,
  windowMs: 600_000,        // 2 per 10 minutes
  keyExtractor: (req) => {
    // Rate limit by satellite ID, not by IP
    return `satellite:${req.body?.satelliteId || 'unknown'}`;
  },
};

// The endpoint itself doesn't need to know about rate limiting —
// the middleware handles it automatically
app.post('/api/satellite/deploy', async (req, res) => {
  const result = await deploySatellite(req.body);
  res.json(result);
});
```

## Related Patterns

- [Redis Optional Caching and Clustering](./redis-optional-caching-and-clustering.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
