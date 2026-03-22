# Graceful Degradation and Optional Init

> Non-blocking startup with per-service .catch() handlers, multi-provider LLM fallback chains, and optional service initialization for resilient orchestrator operation.

## Problem

An orchestrator depends on many services — Redis, PostgreSQL, LLM providers, embedding models, external APIs. If any single dependency fails to initialize or becomes unavailable at runtime, a naive implementation crashes or hangs. But most of these services are enhancing, not essential: the system can operate in a degraded mode without Redis (use in-memory caches), without the primary LLM (fall back to alternatives), and without embedding services (skip semantic search).

## Context

- An orchestrator with 10+ external dependencies that start concurrently
- LLM providers have variable reliability and rate limits
- Redis provides performance benefits but isn't strictly required for core functionality
- Startup must be fast — blocking on a slow dependency delays all requests
- Runtime failures should degrade gracefully, not crash the process

## Solution

### Per-Service .catch() Startup

Rather than a single `Promise.allSettled()` call, each service has its own try/catch or `.catch()` handler. This achieves the same non-blocking intent but gives each service its own error handling context:

```javascript
// index.js — startup sequence
async function start() {
  // Critical: must succeed
  await db.connect();

  // Non-critical: each service handles its own failure
  await recoverySchema.initSchema().catch(err => {
    logger.warn({ err }, 'Recovery schema init failed — running without it');
  });

  await antiPatterns.initSchema().catch(err => {
    logger.warn({ err }, 'Anti-patterns schema init failed — running without it');
  });

  await redis.connect().catch(err => {
    logger.warn({ err }, 'Redis connect failed — using in-memory fallback');
  });

  await embeddings.init().catch(err => {
    logger.warn({ err }, 'Embeddings init failed — falling back to keyword search');
  });

  await calendar.connect().catch(err => {
    logger.warn({ err }, 'Calendar connect failed — running without it');
  });

  // Continue startup with whatever succeeded
  await startServer();
}
```

Each service knows its own failure implications. The per-service pattern makes it clear which service failed and what the degraded behavior will be, without aggregating results into an indexed array.

### LLM Provider Fallback Chain

When the primary LLM provider is unavailable (rate-limited, down, or erroring), the system transparently falls back through alternatives:

```javascript
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
    await client.connect();
    return client;
  } catch (err) {
    logger.warn({ err }, 'Redis connect failed — using in-memory fallback');
    return null;
  }
}
```

### Unhandled Rejection Safety Net

A global handler catches unhandled rejections (often database timeouts) without crashing:

```javascript
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled rejection — not crashing');
  errorStats.record('unhandled_rejection', reason);
});
```

## Implications

- Per-service `.catch()` handlers give each service its own error context — clearer than indexing into a `Promise.allSettled()` results array
- Services initialize sequentially in the shown pattern, not in parallel — this is simpler but slightly slower than `Promise.allSettled()`. Services that are independent could be parallelized if startup time becomes a concern.
- The LLM fallback chain changes response quality transparently — users may notice but the system stays up
- In-memory fallbacks for Redis work for single-instance deployments but lose distributed coordination
- The unhandled rejection handler is a safety net, not a fix — recurring unhandled rejections should be investigated and properly caught

## Code Example

```javascript
// Complete resilient startup sequence
async function startOrchestrator() {
  // 1. Critical dependency — must succeed
  await db.connect();
  logger.info('Database connected');

  // 2. Optional dependencies — each handles its own failure
  await redis.connect().catch(err => {
    logger.warn('Running without Redis — using in-memory locks and caches');
  });

  await embeddings.init().catch(err => {
    logger.warn('Running without embeddings — falling back to keyword search');
  });

  await calendar.connect().catch(err => {
    logger.warn('Running without calendar integration');
  });

  // 3. Start server
  await startServer();
  logger.info('Orchestrator ready (degraded services logged above)');
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
