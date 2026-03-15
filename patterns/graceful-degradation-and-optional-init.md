# Graceful Degradation and Optional Init

> Non-blocking startup with Promise.allSettled(), multi-provider LLM fallback chains, and optional service initialization for resilient orchestrator operation.

## Problem

An orchestrator depends on many services — Redis, PostgreSQL, LLM providers, embedding models, external APIs. If any single dependency fails to initialize or becomes unavailable at runtime, a naive implementation crashes or hangs. But most of these services are enhancing, not essential: the system can operate in a degraded mode without Redis (use in-memory caches), without the primary LLM (fall back to alternatives), and without embedding services (skip semantic search).

## Context

- An orchestrator with 10+ external dependencies that start concurrently
- LLM providers have variable reliability and rate limits
- Redis provides performance benefits but isn't strictly required for core functionality
- Startup must be fast — blocking on a slow dependency delays all requests
- Runtime failures should degrade gracefully, not crash the process

## Solution

### Promise.allSettled() Startup

Non-critical initialization runs through `Promise.allSettled()` so that individual failures don't block startup:

```javascript
// index.js — startup sequence
async function start() {
  // Critical: must succeed
  await db.connect();

  // Non-critical: failures are logged but don't block
  const results = await Promise.allSettled([
    recoverySchema.initSchema(),
    antiPatterns.initSchema(),
    redis.connect(),
    embeddings.init(),
    calendar.connect(),
  ]);

  // Log failures without crashing
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn({ error: result.reason, service: services[i] },
        'Optional service init failed — running without it');
    }
  });

  // Continue startup with whatever succeeded
  await startServer();
}
```

### LLM Provider Fallback Chain

When the primary LLM provider is unavailable (rate-limited, down, or erroring), the system transparently falls back through alternatives:

```javascript
// llm/index.js
async function generate(context, options = {}) {
  // Primary: Claude
  try {
    return await claude.generate(context, options);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    logger.warn('Claude unavailable, falling back to Gemini');
  }

  // Secondary: Gemini
  try {
    return await gemini.generate(context, options);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    logger.warn('Gemini unavailable, falling back to OpenAI');
  }

  // Tertiary: OpenAI
  return await openai.generate(context, options);
}
```

The fallback is transparent to callers — they get a response regardless of which provider served it. Quality may vary between providers, but the system stays operational.

### Redis Optional with In-Memory Fallback

Redis is used for distributed locking and caching, but every Redis-dependent feature has an in-memory fallback:

```javascript
// redis.js
let client = null;

async function connect() {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info('Redis URL not configured — using in-memory fallback');
    return null;
  }

  try {
    client = createClient({ url });
    client.on('error', (err) => logger.warn({ err }, 'Redis error'));

    // Reconnection with exponential backoff
    client.on('reconnecting', ({ delay }) => {
      logger.info({ delay }, 'Redis reconnecting');
    });

    await client.connect();
    return client;
  } catch (err) {
    logger.warn({ err }, 'Redis connect failed — using in-memory fallback');
    return null;
  }
}

function isEnabled() {
  return client?.isReady === true;
}
```

Consumers check `redis.isEnabled()` before using Redis, falling back to local alternatives:

```javascript
// Example: job locking with Redis or in-memory fallback
async function acquireLock(jobName) {
  if (redis.isEnabled()) {
    return await redis.set(key, token, { NX: true, PX: timeout });
  }
  // In-memory fallback (single-instance only)
  return acquireLocalLock(jobName, token, timeout);
}
```

### Cognitive Producer Resilience

Cognitive producers (event generators) start independently. Individual producer failures don't stop the others:

```javascript
// cognitive/producers/index.js
async function startAll() {
  const results = await Promise.allSettled(
    producers.map(p => p.start())
  );

  const started = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  logger.info({ started, failed, total: producers.length },
    'Cognitive producers initialized');

  // Per-producer error handling — log but don't crash
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.error({ producer: producers[i].name, err: result.reason },
        'Producer failed to start');
    }
  });
}
```

### Embedding Queue Degradation

When the embedding service is overloaded, the queue degrades gracefully:

```javascript
// unified-memory/embedding-queue.js
async function processBatch(items) {
  const results = await Promise.allSettled(
    items.map(item => generateEmbedding(item.text))
  );

  // Store successful embeddings, re-queue failures
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      storeEmbedding(items[i].id, result.value);
    } else {
      // Re-queue with backoff, don't crash
      requeue(items[i], { delay: 60_000 });
    }
  });
}

// Queue full? Degrade to non-semantic operation
async function search(query) {
  if (embeddingQueue.isFull()) {
    logger.warn('Embedding queue full — falling back to keyword search');
    return keywordSearch(query);
  }
  return semanticSearch(query);
}
```

### Unhandled Rejection Safety Net

A global handler catches unhandled rejections (often database timeouts) without crashing:

```javascript
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled rejection — not crashing');
  // Record for monitoring but don't exit
  errorStats.record('unhandled_rejection', reason);
});
```

## Implications

- `Promise.allSettled()` trades fail-fast for resilience — bugs in initialization might be silently swallowed. Good logging is essential.
- The LLM fallback chain changes response quality transparently — users may notice but the system stays up. Consider logging which provider served each request.
- In-memory fallbacks for Redis work for single-instance deployments but lose distributed coordination (e.g., locks only protect within one process)
- Embedding queue degradation means search quality drops under load — keyword search is less accurate than semantic search but always available
- The unhandled rejection handler is a safety net, not a fix — recurring unhandled rejections should be investigated and properly caught

## Code Example

```javascript
// Complete resilient startup sequence
async function startOrchestrator() {
  // 1. Critical dependency — must succeed
  await db.connect();
  logger.info('Database connected');

  // 2. Optional dependencies — best-effort
  const [redisResult, embeddingsResult, calendarResult] = await Promise.allSettled([
    redis.connect(),
    embeddings.init(),
    calendar.connect(),
  ]);

  // 3. Log degraded capabilities
  if (redisResult.status === 'rejected') {
    logger.warn('Running without Redis — using in-memory locks and caches');
  }
  if (embeddingsResult.status === 'rejected') {
    logger.warn('Running without embeddings — falling back to keyword search');
  }

  // 4. Start cognitive system (per-producer resilience)
  await cognitive.startAll();

  // 5. Start server
  await startServer();
  logger.info('Orchestrator ready (degraded services logged above)');
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
