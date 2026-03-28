# Request-Scoped Context Propagation

> AsyncLocalStorage-based per-request context with `runWithRequestContext` for correlation IDs and embedding caches, while tenant context has been stripped of AsyncLocalStorage entirely — `getCurrentTenantId()` always returns `1`.

## Problem

In an orchestrator handling concurrent requests, deeply nested async functions need access to request-scoped data — correlation IDs for log tracing, per-request embedding caches, user IDs. The naive solution is parameter drilling: passing a `context` object through every function in the call chain. This works at first, then metastasizes. Every function signature grows a `ctx` parameter. Utility functions that previously had clean interfaces now need request context they don't logically care about, just to pass it deeper. Refactoring becomes painful because adding a new piece of context means touching every intermediate function.

## Context

- Node.js async operations (HTTP handlers, WebSocket messages, job dispatchers)
- Correlation IDs needed in every audit log for distributed tracing
- Per-request embedding caches that must not leak between requests
- Deep call stacks: handler -> service -> repository -> cache -> external API
- Multi-tenancy has been completely removed — tenant context is a no-op stub

## Solution

### The Store

`AsyncLocalStorage` provides a store scoped to the current async execution context. The function is named `runWithRequestContext` (not `runWithContext`):

```javascript
// lib/request-context.js
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithRequestContext(values, fn) {
  const parent = storage.getStore();
  const next = parent ? { ...parent, ...values } : { ...(values || {}) };

  // Lazily create a per-request embedding cache
  if (!next.embeddingCache) next.embeddingCache = new Map();

  return storage.run(next, fn);
}

function getStore() {
  return storage.getStore() || null;
}

function getEmbeddingCache() {
  return storage.getStore()?.embeddingCache || null;
}

function getCorrelationId() {
  return storage.getStore()?.correlationId || null;
}

function getUserId() {
  return storage.getStore()?.userId || null;
}
```

Key design points:
- Parent context is merged, not replaced — nested `runWithRequestContext` calls inherit outer values
- The embedding cache is lazily created as a `Map` storing Promises, so parallel callers dedupe embedding work within the same request
- Accessors return `null` (not `undefined`) when outside a context, making missing-context checks explicit

### Per-Request Embedding Cache

The embedding cache stores Promises, not resolved values. This means if two async paths within the same request both call `getEmbedding("hello")` concurrently, the second call gets the same Promise as the first — deduplicating the API call:

```javascript
// lib/unified-memory/embeddings.js (illustrative usage)
async function getEmbedding(text) {
  const cache = requestContext.getEmbeddingCache();
  if (cache?.has(text)) return cache.get(text);

  const promise = embeddingProvider.embed(text);
  if (cache) cache.set(text, promise);

  return promise;
}
```

### Correlation ID in Audit Logging

The audit system pulls the correlation ID from request context without any parameter passing:

```javascript
// lib/audit/core.js
function log(operation, data = {}, options = {}) {
  const corrId =
    options.correlationId ||
    data.correlationId ||
    requestContext.getCorrelationId();  // Falls through to AsyncLocalStorage

  const entry = {
    id: `aud_${ulid()}`,
    ts: new Date().toISOString(),
    op: operation,
    corrId,
    data: sanitize(data),
  };

  buffer.push(entry);
}
```

### Tenant Context (Stripped of AsyncLocalStorage)

The tenant context module has been completely stripped of AsyncLocalStorage. It's a no-op stub where `getCurrentTenantId()` always returns `1` and `runWithTenant()` calls its callback directly:

```javascript
// lib/tenant-context.js (compiled from TypeScript)
function runWithTenant(_tenantId, callback) {
  return callback();  // No AsyncLocalStorage, no scoping
}

function getCurrentTenantId() {
  return 1;  // Always single tenant
}

function shouldBypassScoping() {
  return false;
}
```

This is a deliberate simplification — multi-tenancy was removed entirely, not just disabled. There is no AsyncLocalStorage overhead for tenant resolution, no per-tenant data separation, and no runtime tenant context. The functions exist for interface compatibility but do nothing.

### WebSocket and Job Contexts

HTTP requests aren't the only entry point. WebSocket messages and background jobs wrap their work in `runWithRequestContext`:

```javascript
// For WebSocket messages
socket.on('message', (msg) => {
  requestContext.runWithRequestContext({
    correlationId: msg.correlationId || newCorrelationId(),
    userId: socket.userId,
  }, () => handleMessage(msg));
});

// For background jobs
async function runJob(jobName, jobFn) {
  return requestContext.runWithRequestContext({
    correlationId: `job:${jobName}:${ulid()}`,
  }, jobFn);
}
```

## Implications

- `runWithRequestContext` (not `runWithContext`) is the correct function name — the module exports this specific name
- Parent context merging means nested contexts inherit outer values — useful for jobs that spawn sub-requests
- The embedding cache stores Promises for deduplication, not resolved values — this is critical for parallel embedding lookups within a request
- Tenant context is a completely separate module (`tenant-context.js`) that does NOT use AsyncLocalStorage — it's a stub returning `1`
- There is no `set()` or `get()` by key — the module exports specific typed accessors (`getCorrelationId`, `getUserId`, `getEmbeddingCache`)
- The store is eligible for GC once all async operations in the context complete — no manual cleanup needed
- Testing requires wrapping calls in `runWithRequestContext` or accessors return `null`

## Code Example

```javascript
// Full request lifecycle showing context propagation
const requestContext = require('./lib/request-context');
const audit = require('./lib/audit');

// 1. HTTP middleware initializes context
app.use((req, res, next) => {
  requestContext.runWithRequestContext({
    correlationId: req.headers['x-correlation-id'] || audit.newCorrelationId(),
    userId: req.user?.id,
  }, () => next());
});

// 2. Route handler — no context parameters needed
app.post('/api/search', async (req, res) => {
  // audit.log automatically picks up correlationId from context
  audit.log('search:start', { query: req.body.query });

  const results = await searchService.search(req.body.query);

  audit.log('search:complete', { resultCount: results.length });
  res.json({ results });
});

// 3. Deep in the stack, embedding cache deduplicates work
async function search(query) {
  const embedding1 = await getEmbedding(query);  // API call
  const embedding2 = await getEmbedding(query);  // Cache hit (same Promise)
  // embedding1 === embedding2 (same Promise reference)
}

// 4. Tenant context is completely separate and always returns 1
const { getCurrentTenantId } = require('./lib/tenant-context');
getCurrentTenantId();  // Always 1, no AsyncLocalStorage involved
```

## Related Patterns

- [Audit Trail with PII Sanitization](./audit-trail-with-pii-sanitization.md)
- [Unified Event System](./unified-event-system.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
