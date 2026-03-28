# Graceful Degradation and Optional Init

> Non-blocking startup combining `Promise.allSettled()` for schema initializers with per-service `.catch()` handlers, a Gemini-primary LLM fallback chain (Gemini -> Claude -> OpenAI), and optional service initialization for resilient orchestrator operation.

## Problem

An orchestrator depends on many services — Redis, PostgreSQL, LLM providers, embedding models, external APIs. If any single dependency fails to initialize or becomes unavailable at runtime, a naive implementation crashes or hangs. But most of these services are enhancing, not essential: the system can operate in a degraded mode without Redis (use in-memory caches), without the primary LLM (fall back to alternatives), and without embedding services (skip semantic search).

## Context

- An orchestrator with 10+ external dependencies that start concurrently
- LLM providers have variable reliability and rate limits
- Redis provides performance benefits but isn't strictly required for core functionality
- Startup must be fast — blocking on a slow dependency delays all requests
- Runtime failures should degrade gracefully, not crash the process

## Solution

### Mixed Startup Strategy

The actual startup combines two patterns: `Promise.allSettled()` for groups of related schema initializers, and individual `.catch()` handlers for independent service connections. This is not one or the other — it's both:

```javascript
// index.js — startup sequence

// Critical: must succeed
db.init()
  .then(async () => {
    // Late schema initializers grouped with Promise.allSettled()
    const recoverySchema = require('./lib/agent/recovery/schema');
    const antiPatterns = require('./lib/learning/anti-patterns');

    await Promise.allSettled([
      recoverySchema.initSchema(),
      antiPatterns.initSchema(),
    ]);
  })
  .catch(e => logger.warn({ err: e }, 'DB init warning'));

// Independent services with individual .catch() handlers
uiCache.init().catch(e => logger.warn({ err: e }, 'UI cache init warning'));
google.init();
github.init();
embeddings.init().catch(e => logger.warn({ err: e }, 'Embeddings init warning'));
```

The `Promise.allSettled()` call groups schema initializers that share a dependency (database must be ready) and should run concurrently. Individual `.catch()` handlers wrap independent services that can fail without affecting others. This combination gives each failure its own error context while allowing related initializers to parallelize.

### Unhandled Rejection Safety Net

A global handler catches unhandled rejections — particularly database timeouts during startup — without crashing:

```javascript
process.on('unhandledRejection', (reason, promise) => {
  const message = reason?.message || String(reason);
  // Database connection errors are recoverable
  if (message.includes('Connection terminated') || message.includes('timeout')) {
    logger.error({ reason }, '[Startup] Database connection error (will retry)');
    return;
  }
  logger.fatal({ reason }, '[Unhandled Rejection]');
});
```

### LLM Provider Fallback Chain

The LLM system uses Gemini as the primary provider (not Claude). When Gemini is rate-limited, the system transparently falls back through Claude, then OpenAI:

```javascript
// lib/llm/index.js
async function generate(request) {
  const routing = router.route(request);
  const provider = providers[routing.provider] || gemini;

  try {
    response = await retryWithBackoff(
      () => provider.generate(enrichedRequest),
      request.maxRetries ?? 2
    );
  } catch (err) {
    const isRateLimitError =
      err.message?.includes('429') ||
      err.message?.includes('RESOURCE_EXHAUSTED') ||
      err.message?.includes('quota');

    if (isRateLimitError && routing.provider === 'gemini') {
      // Fallback 1: Claude
      if (claude.isAvailable()) {
        logger.warn('Gemini rate limited; falling back to Claude');
        response = await claude.generate({ ...enrichedRequest, model: models.CLAUDE_MODEL });
        usedFallback = true;
      }
      // Fallback 2: OpenAI
      else if (openai.isAvailable()) {
        logger.warn('Gemini rate limited; falling back to OpenAI');
        response = await openai.generate({ ...enrichedRequest, model: models.OPENAI_MODEL });
        usedFallback = true;
      }
      else throw err;
    } else throw err;
  }
}
```

The fallback chain is Gemini -> Claude -> OpenAI. Fallback is only triggered by rate limit errors (429, RESOURCE_EXHAUSTED, quota). Other errors propagate normally. The response includes routing metadata so callers can detect when a fallback was used.

### Provider Validation at Startup

The system validates that at least one LLM provider is configured before starting:

```javascript
const USE_CLAUDE = process.env.PREFER_CLAUDE === 'true' && process.env.ANTHROPIC_API_KEY;
const USE_GEMINI = process.env.GEMINI_API_KEY && !USE_CLAUDE;

if (!USE_CLAUDE && !USE_GEMINI) {
  logger.fatal('Missing API keys - need either ANTHROPIC_API_KEY or GEMINI_API_KEY');
  process.exit(1);
}
```

### Tenant Initialization

Even the tenant system uses optional init — the default tenant is created if missing, but failure is a warning, not a crash:

```javascript
const tenantReady = tenants.getOrCreateDefault()
  .then(t => logger.info({ tenant: t.name }, 'Tenant ready'))
  .catch(e => logger.warn({ err: e }, 'Tenant init warning'));
```

## Implications

- `Promise.allSettled()` for schema inits means both recovery schema and anti-patterns table can fail independently without blocking each other or the rest of startup
- Per-service `.catch()` handlers for independent services give each service its own error context and degraded behavior description
- The LLM fallback chain is Gemini-primary (not Claude-primary) — Gemini handles the majority of traffic including chat and tool calling, with Claude reserved for complex reasoning
- Fallback only triggers on rate limit errors — other errors (authentication, network) propagate immediately rather than cascading through providers
- The `retryWithBackoff` wrapper provides within-provider retry before cross-provider fallback
- OpenAI is available as tertiary fallback but requires explicit `RILEY_OPENAI_ENABLED=true` opt-in
- The unhandled rejection handler distinguishes database timeouts (recoverable, logged as error) from other rejections (logged as fatal) — it's a safety net, not a fix

## Code Example

```javascript
// Complete resilient startup sequence from index.js

// 1. Global safety net
process.on('unhandledRejection', (reason) => {
  if (reason?.message?.includes('Connection terminated')) {
    logger.error({ reason }, 'Database connection error (will retry)');
    return;
  }
  logger.fatal({ reason }, '[Unhandled Rejection]');
});

// 2. Critical dependency
db.init()
  .then(async () => {
    // Schema inits grouped with Promise.allSettled()
    await Promise.allSettled([
      recoverySchema.initSchema(),
      antiPatterns.initSchema(),
    ]);
  })
  .catch(e => logger.warn({ err: e }, 'DB init warning'));

// 3. Independent services — each handles its own failure
uiCache.init().catch(e => logger.warn({ err: e }, 'UI cache init warning'));
google.init();
github.init();
embeddings.init().catch(e => logger.warn({ err: e }, 'Embeddings init warning'));

// 4. Tenant readiness
tenants.getOrCreateDefault()
  .then(t => logger.info({ tenant: t.name }, 'Tenant ready'))
  .catch(e => logger.warn({ err: e }, 'Tenant init warning'));

// 5. LLM: Gemini primary, Claude fallback, OpenAI tertiary
// Validated at startup: at least one of GEMINI_API_KEY or ANTHROPIC_API_KEY required
```

## Related Patterns

- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
- [Distributed Job Locking](./distributed-job-locking.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
