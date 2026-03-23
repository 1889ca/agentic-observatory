# Redis Optional Caching and Clustering

> Optional Redis integration with exponential backoff reconnection, Socket.io multi-instance adapter, health checks, and graceful in-memory fallback for every consumer.

## Problem

Redis is extremely useful for caching, pub/sub, and distributed coordination — but making it a hard dependency creates fragility. If Redis goes down, the entire application goes down. If Redis is slow to start, the application hangs on boot. In development, requiring Redis running locally adds friction to onboarding. And when Redis recovers after an outage, aggressive reconnection attempts can overwhelm it with a thundering herd of connections before it's ready to serve traffic. The system needs Redis when it's available, but must survive without it.

## Context

- A Node.js orchestrator that benefits from Redis for caching, pub/sub, and distributed locking
- Multiple instances of the application may run behind a load balancer, needing Socket.io message coordination
- Redis availability varies across environments — always present in production, often absent in local development
- Some features degrade without Redis (distributed locks become local-only) but the core system must keep running
- Redis outages should be recoverable without application restarts
- Health check endpoints need to report Redis status accurately

## Solution

### Optional Connection with Environment Configuration

The Redis module initializes only when configured. The entire module API works regardless — consumers never check whether Redis is available before calling methods:

```typescript
// lib/redis.ts
import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | null = null;
let isConnected = false;
let reconnectAttempts = 0;

const MAX_RECONNECT_DELAY = 30000; // 30 seconds cap
const BASE_RECONNECT_DELAY = 1000; // 1 second initial

function getRedisUrl(): string | null {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;

  if (!host) return null;

  return password
    ? `redis://:${password}@${host}:${port}`
    : `redis://${host}:${port}`;
}

async function init(): Promise<void> {
  const url = getRedisUrl();
  if (!url) {
    logger.info('Redis not configured — using in-memory fallbacks');
    return;
  }

  client = createClient({ url });

  client.on('connect', () => {
    isConnected = true;
    reconnectAttempts = 0;
    logger.info('Redis connected');
  });

  client.on('error', (err) => {
    logger.warn({ err: err.message }, 'Redis error');
  });

  client.on('end', () => {
    isConnected = false;
    logger.warn('Redis disconnected');
    scheduleReconnect();
  });

  try {
    await client.connect();
  } catch (err) {
    logger.warn({ err }, 'Redis initial connection failed — will retry');
    scheduleReconnect();
  }
}
```

### Exponential Backoff Reconnection

When Redis disconnects, reconnection uses exponential backoff with jitter. This prevents thundering herd on Redis recovery and avoids log spam from tight retry loops:

```typescript
function scheduleReconnect(): void {
  if (!client) return;

  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );

  // Add jitter: +/- 25% of the delay
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  const actualDelay = Math.round(delay + jitter);

  reconnectAttempts++;

  logger.info(
    { attempt: reconnectAttempts, delayMs: actualDelay },
    'Scheduling Redis reconnection'
  );

  setTimeout(async () => {
    try {
      await client?.connect();
    } catch {
      scheduleReconnect(); // Keep trying
    }
  }, actualDelay);
}
```

### In-Memory Fallback for Every Operation

Every Redis operation has an in-memory fallback. The cache API is the most critical — it uses a `Map` with TTL tracking when Redis isn't available:

```typescript
const localCache = new Map<string, { value: string; expiresAt: number }>();

async function cacheGet(key: string): Promise<string | null> {
  if (isConnected && client) {
    try {
      return await client.get(key);
    } catch {
      // Redis failed mid-operation — fall through to local
    }
  }

  const entry = localCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }
  return entry.value;
}

async function cacheSet(key: string, value: string, ttlMs: number): Promise<void> {
  if (isConnected && client) {
    try {
      await client.set(key, value, { PX: ttlMs });
      return;
    } catch {
      // Fall through to local
    }
  }

  localCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function cacheDel(key: string): Promise<void> {
  localCache.delete(key);

  if (isConnected && client) {
    try {
      await client.del(key);
    } catch {
      // Best-effort
    }
  }
}
```

### Socket.io Adapter for Multi-Instance Pub/Sub

When multiple application instances run behind a load balancer, Socket.io events emitted on one instance need to reach clients connected to other instances. Redis acts as the pub/sub backbone:

```typescript
import { createAdapter } from '@socket.io/redis-adapter';

async function attachSocketAdapter(io: SocketIOServer): Promise<void> {
  if (!isConnected || !client) {
    logger.info('Redis unavailable — Socket.io running in single-instance mode');
    return;
  }

  const pubClient = client.duplicate();
  const subClient = client.duplicate();

  await Promise.all([pubClient.connect(), subClient.connect()]);

  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.io Redis adapter attached — multi-instance pub/sub enabled');
}
```

Without Redis, Socket.io defaults to in-process event distribution — functional for single-instance deployments, degraded for multi-instance.

### Health Check Integration

The Redis module exposes its status for the health check endpoint. This is informational, not a gate — the application is "healthy" even without Redis, but operators need visibility:

```typescript
function getHealthStatus(): { available: boolean; latencyMs?: number } {
  if (!client || !isConnected) {
    return { available: false };
  }

  return { available: true };
}

async function ping(): Promise<number | null> {
  if (!isConnected || !client) return null;

  const start = Date.now();
  try {
    await client.ping();
    return Date.now() - start;
  } catch {
    return null;
  }
}
```

### Local Cache Eviction

The in-memory fallback needs periodic cleanup to prevent unbounded growth. A sweep runs on an interval, removing expired entries:

```typescript
setInterval(() => {
  const now = Date.now();
  let evicted = 0;

  for (const [key, entry] of localCache) {
    if (now > entry.expiresAt) {
      localCache.delete(key);
      evicted++;
    }
  }

  if (evicted > 0) {
    logger.debug({ evicted, remaining: localCache.size }, 'Local cache sweep');
  }
}, 60_000); // Every minute
```

## Implications

- Every Redis consumer must handle the "no Redis" case — this is a design constraint that prevents accidental hard dependencies
- The in-memory fallback is single-instance only — distributed features like cross-instance pub/sub genuinely degrade, they don't just slow down
- Exponential backoff with jitter prevents thundering herd but means recovery after an outage takes time (up to 30 seconds worst case)
- The local cache has no size limit beyond TTL expiration — for high-cardinality caching, this could become a memory concern
- Socket.io in single-instance mode means sticky sessions are required at the load balancer level, or clients may miss events
- Redis connection state transitions (connected/disconnected) can happen mid-request — every operation needs its own try/catch, not a single upfront check

## Code Example

```typescript
// Usage: a module that caches expensive API responses, unaware of Redis internals
import { cacheGet, cacheSet, isEnabled } from '../lib/redis';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getProjectSummary(projectId: string): Promise<ProjectSummary> {
  const cacheKey = `project:summary:${projectId}`;

  // Try cache first
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss — compute the expensive result
  const summary = await computeProjectSummary(projectId);

  // Cache for next time (works with or without Redis)
  await cacheSet(cacheKey, JSON.stringify(summary), CACHE_TTL);

  return summary;
}

// Health endpoint integration
app.get('/health', async (req, res) => {
  const redisLatency = await ping();
  res.json({
    status: 'ok',
    redis: {
      available: isEnabled(),
      latencyMs: redisLatency,
    },
  });
});
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
