# Request-Scoped Context Propagation

> AsyncLocalStorage-based per-request context (correlation IDs, embedding caches, tenant isolation stub) avoiding parameter drilling through async chains. Note: multi-tenancy is completely inactive — `tenantId` is hardcoded to `1` in `unified-events.ts`, meaning all data shares a single tenant namespace.

## Problem

In a multi-tenant orchestrator handling concurrent requests, deeply nested async functions need access to request-scoped data — the current tenant, a correlation ID for log tracing, per-request embedding caches, user preferences. The naive solution is parameter drilling: passing a `context` object through every function in the call chain. This works at first, then metastasizes. Every function signature grows a `ctx` parameter. Utility functions that previously had clean interfaces now need request context they don't logically care about, just to pass it deeper. Refactoring becomes painful because adding a new piece of context means touching every intermediate function. Worse, a single missed parameter in the chain silently breaks tracing or tenant isolation.

## Context

- Node.js async operations (HTTP handlers, WebSocket messages, job dispatchers)
- Multi-tenant system where tenant isolation is structurally prepared (currently a stub hardcoded to tenant 1)
- Correlation IDs needed in every log line for distributed tracing
- Per-request embedding caches that must not leak between requests
- Middleware-based request lifecycle (Express, Fastify, or custom)
- Deep call stacks: handler -> service -> repository -> cache -> external API

## Solution

### The Store

`AsyncLocalStorage` provides a store scoped to the current async execution context. It follows `await` boundaries, `setTimeout` callbacks, and `Promise` chains automatically — anything that Node.js tracks as part of the same async resource gets the same store.

```javascript
// lib/request-context.js
const { AsyncLocalStorage } = require('node:async_hooks');

const requestStore = new AsyncLocalStorage();

function runWithContext(contextData, fn) {
  return requestStore.run(contextData, fn);
}

function getContext() {
  return requestStore.getStore();
}

function get(key) {
  const store = requestStore.getStore();
  return store?.[key];
}

function set(key, value) {
  const store = requestStore.getStore();
  if (store) store[key] = value;
}

module.exports = { runWithContext, getContext, get, set };
```

### Middleware Initialization

Every inbound request is wrapped in a `runWithContext` call that creates the store before any async work begins. This is the critical invariant — if async work starts before the store is initialized, it won't have access to context.

```javascript
// middleware/request-context.js
const { randomUUID } = require('node:crypto');
const reqCtx = require('../lib/request-context');

function requestContextMiddleware(req, res, next) {
  const context = {
    correlationId: req.headers['x-correlation-id'] || randomUUID(),
    tenantId: req.tenant?.id || null,
    userId: req.user?.id || null,
    startedAt: Date.now(),
    cache: new Map(),  // Per-request cache, GC'd when request ends
  };

  // Set correlation ID on response for downstream tracing
  res.setHeader('x-correlation-id', context.correlationId);

  reqCtx.runWithContext(context, () => next());
}
```

The `cache` field is a fresh `Map` per request. Functions that perform expensive operations (embedding lookups, permission checks) can cache results here without worrying about cross-request leakage — the entire store is garbage collected when the request's async chain completes.

### Correlation ID in Logging

With the store in place, loggers pull the correlation ID without any parameter passing:

```javascript
// lib/logger.js
const reqCtx = require('./request-context');

function createLogger(module) {
  return {
    info(message, data = {}) {
      const correlationId = reqCtx.get('correlationId');
      console.log(JSON.stringify({
        level: 'info',
        module,
        correlationId: correlationId || 'no-request',
        message,
        ...data,
        timestamp: Date.now(),
      }));
    },
    // warn, error follow same pattern
  };
}
```

Every log line across every module in the async chain includes the same correlation ID. No parameter drilling needed. Grep a single ID in your log aggregator and you get the full request trace.

### Tenant Isolation (Completely Inactive)

The tenant isolation infrastructure exists in code but is completely inactive. In `unified-events.ts`, `tenantId` is hardcoded to `1` — there is no runtime tenant resolution, no per-tenant data separation, and all data shares a single tenant namespace. The AsyncLocalStorage pattern is real and functional for correlation IDs and embedding caches, but multi-tenancy is a dead code path. The code below shows the prepared abstraction, but none of it is exercised with real multi-tenant data today:

```javascript
// lib/tenant-context.ts
import * as reqCtx from './request-context';

export function getTenantId(): string {
  const tenantId = reqCtx.get('tenantId');
  if (!tenantId) {
    throw new Error('No tenant context — operation requires tenant scope');
  }
  return tenantId;
}

export function getTenantPrefix(): string {
  return `tenant:${getTenantId()}`;
}

export function scopeKey(key: string): string {
  return `${getTenantPrefix()}:${key}`;
}
```

Database queries, cache keys, and external API calls all use `getTenantId()` to enforce isolation in theory. In practice, `tenantId` is always `1` (hardcoded in `unified-events.ts`), so the isolation plumbing is never exercised with real multi-tenant data. The throw-on-missing pattern catches cases where code runs outside a request context, but with the hardcoded tenant ID, this is effectively a no-op safety net.

### Per-Request Embedding Cache

Embedding operations are expensive. Within a single request, the same text may need to be embedded multiple times (semantic search, similarity check, classification). The per-request cache prevents redundant API calls:

```javascript
// lib/embedding.js
const reqCtx = require('./request-context');

async function getEmbedding(text) {
  const cache = reqCtx.get('cache');
  const cacheKey = `embedding:${text}`;

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const embedding = await embeddingProvider.embed(text);

  if (cache) {
    cache.set(cacheKey, embedding);
  }

  return embedding;
}
```

The cache lives only for the request duration. No TTL management, no invalidation logic, no size limits to worry about — the garbage collector handles cleanup when the request's async context is released.

### WebSocket and Job Contexts

HTTP requests aren't the only entry point. WebSocket messages and background jobs need their own context wrapping:

```javascript
// For WebSocket messages
socket.on('message', (msg) => {
  reqCtx.runWithContext({
    correlationId: msg.correlationId || randomUUID(),
    tenantId: socket.tenantId,
    userId: socket.userId,
    cache: new Map(),
  }, () => handleMessage(msg));
});

// For background jobs
async function runJob(jobName, tenantId, jobFn) {
  return reqCtx.runWithContext({
    correlationId: `job:${jobName}:${randomUUID()}`,
    tenantId,
    userId: null,
    cache: new Map(),
  }, jobFn);
}
```

The same `getContext()` / `get()` / `set()` accessors work identically regardless of whether the context was created by HTTP middleware, a WebSocket handler, or a job dispatcher.

## Implications

- **Minor performance overhead** — `AsyncLocalStorage` adds a small cost per async operation (microseconds). For typical request workloads this is negligible; for tight loops processing thousands of async operations per request, measure first.
- **Invisible data flow** — The store is implicit. Reading the code, you can't see where `correlationId` comes from without knowing about the middleware. This trades explicit parameter passing for implicit context. The tradeoff is worth it, but new contributors need to understand the pattern.
- **Must initialize before async work** — If `runWithContext` is called after an `await`, the store won't propagate to work that started before it. Middleware must wrap the entire request handler, not just part of it.
- **Garbage collected per request** — The store (including the cache `Map`) is eligible for GC once all async operations in the context complete. No manual cleanup needed, but large caches in long-running requests could temporarily increase memory pressure.
- **No cross-process propagation** — `AsyncLocalStorage` is process-local. For distributed tracing across services, the correlation ID must be explicitly forwarded in outbound HTTP headers or message payloads.
- **Testing requires wrapping** — Tests that call functions relying on `get()` must wrap the call in `runWithContext` or the values will be `undefined`. A test helper simplifies this.
- **TypeScript strictness** — The generic `get(key)` accessor returns `any`. For type safety, `tenant-context.ts` wraps specific fields with typed accessors rather than exposing the raw store.

## Code Example

```javascript
// Full request lifecycle showing context propagation

// 1. Middleware initializes context
app.use(requestContextMiddleware);

// 2. Route handler — no context parameters needed
app.post('/api/search', async (req, res) => {
  const logger = createLogger('search');
  logger.info('Search request received', { query: req.body.query });

  // 3. Service layer reads context implicitly
  const results = await searchService.search(req.body.query);

  logger.info('Search complete', { resultCount: results.length });
  res.json({ results });
});

// 4. Service uses tenant isolation and embedding cache
// searchService.js
async function search(query) {
  const tenantId = getTenantId();  // From context — throws if missing
  const embedding = await getEmbedding(query);  // Cached per-request

  const results = await vectorStore.query({
    embedding,
    filter: { tenantId },
    limit: 10,
  });

  // Second call to getEmbedding with same text hits cache
  const reranked = await rerank(results, query);
  return reranked;
}

// 5. Deep in the stack, logger still has correlation ID
// vectorStore.js
async function query({ embedding, filter, limit }) {
  const logger = createLogger('vector-store');
  logger.info('Querying vectors', { filter, limit });
  // correlationId automatically included in log output
  // ...
}
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Audit Logging with Correlation Tracing](./audit-logging-and-correlation.md)
