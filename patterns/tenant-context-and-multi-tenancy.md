# Tenant Context and Multi-Tenancy

> Request-scoped tenant isolation via async local storage with automatic database scoping and configuration partitioning.

## Problem

A multi-tenant orchestrator serves multiple users or organizations through the same runtime. Without isolation, tenant A's data leaks into tenant B's context. The naive solution — passing a `tenantId` parameter through every function — is fragile and scales poorly. One missed parameter in a deeply nested call chain means a cross-tenant data breach. Rate limits, feature flags, and configuration also need per-tenant scoping, but threading those through every layer turns every function signature into a grab-bag of context parameters.

## Context

- A Node.js-based orchestrator serving multiple tenants from a single process
- Database queries that must be scoped to the requesting tenant
- Per-tenant configuration: rate limits, feature flags, model preferences
- Deep call chains where explicit parameter passing is impractical
- A need to guarantee that no code path can accidentally access another tenant's data
- Middleware-based HTTP or WebSocket request handling

## Solution

### AsyncLocalStorage Setup

Node.js `AsyncLocalStorage` provides request-scoped context that flows through the entire async call chain without explicit parameter passing:

```javascript
import { AsyncLocalStorage } from 'node:async_hooks';

const tenantContext = new AsyncLocalStorage();

function getTenant() {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error('No tenant context — are you inside a request scope?');
  }
  return ctx;
}

function runWithTenant(tenant, fn) {
  return tenantContext.run(tenant, fn);
}
```

### Middleware Integration

The tenant context is established at the request boundary — before any business logic runs:

```javascript
function tenantMiddleware(req, res, next) {
  const tenantId = extractTenantId(req);

  if (!tenantId) {
    return res.status(401).json({ error: 'Tenant identification required' });
  }

  const tenant = {
    id: tenantId,
    requestId: crypto.randomUUID(),
    startedAt: Date.now()
  };

  runWithTenant(tenant, () => {
    // Attach to response for logging
    res.on('finish', () => {
      const duration = Date.now() - tenant.startedAt;
      logger.info({ tenantId, requestId: tenant.requestId, duration }, 'request complete');
    });

    next();
  });
}

function extractTenantId(req) {
  // API key header, JWT claim, or subdomain
  return req.headers['x-tenant-id']
    || req.auth?.tenantId
    || req.hostname.split('.')[0];
}
```

### Auto-Scoped Database Queries

A database wrapper automatically injects the current tenant's ID into every query, making cross-tenant access structurally impossible:

```javascript
class TenantScopedDB {
  constructor(db) {
    this.db = db;
  }

  async findMany(table, where = {}) {
    const tenant = getTenant();
    return this.db.query(
      `SELECT * FROM ${table} WHERE tenant_id = $1 AND ${buildWhere(where, 2)}`,
      [tenant.id, ...Object.values(where)]
    );
  }

  async insert(table, data) {
    const tenant = getTenant();
    const scoped = { ...data, tenant_id: tenant.id };
    const columns = Object.keys(scoped).join(', ');
    const placeholders = Object.keys(scoped).map((_, i) => `$${i + 1}`).join(', ');

    return this.db.query(
      `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
      Object.values(scoped)
    );
  }

  async update(table, where, data) {
    const tenant = getTenant();
    const setClauses = Object.keys(data).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const whereOffset = Object.keys(data).length + 1;

    return this.db.query(
      `UPDATE ${table} SET ${setClauses} WHERE tenant_id = $${whereOffset} AND ${buildWhere(where, whereOffset + 1)}`,
      [...Object.values(data), tenant.id, ...Object.values(where)]
    );
  }

  async delete(table, where) {
    const tenant = getTenant();
    return this.db.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND ${buildWhere(where, 2)}`,
      [tenant.id, ...Object.values(where)]
    );
  }
}
```

### Tenant-Aware Configuration

Configuration, rate limits, and feature flags are loaded per tenant and cached with the tenant context:

```javascript
class TenantConfig {
  constructor(configStore) {
    this.configStore = configStore;
    this.cache = new Map();
  }

  async get(key) {
    const tenant = getTenant();
    const cacheKey = `${tenant.id}:${key}`;

    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.loadedAt < 60000) return cached.value;
    }

    const value = await this.configStore.get(tenant.id, key)
      ?? await this.configStore.get('default', key);

    this.cache.set(cacheKey, { value, loadedAt: Date.now() });
    return value;
  }

  async getAll() {
    const tenant = getTenant();
    const defaults = await this.configStore.getAll('default');
    const overrides = await this.configStore.getAll(tenant.id);
    return { ...defaults, ...overrides };
  }
}

// Usage deep in the call chain — no tenantId parameter needed
async function selectModel(taskType) {
  const config = new TenantConfig(configStore);
  const modelPrefs = await config.get('model_preferences');
  const budget = await config.get('token_budget');

  return modelPrefs[taskType] || modelPrefs.default;
}
```

### Rate Limiting Per Tenant

Rate limits are enforced using the implicit tenant context, preventing one tenant from starving others:

```javascript
class TenantRateLimiter {
  constructor(redis) {
    this.redis = redis;
  }

  async check(operation) {
    const tenant = getTenant();
    const config = await tenantConfig.get('rate_limits');
    const limit = config[operation] || config.default;

    const key = `ratelimit:${tenant.id}:${operation}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, limit.windowSeconds);
    }

    if (current > limit.maxRequests) {
      throw new RateLimitError({
        tenantId: tenant.id,
        operation,
        limit: limit.maxRequests,
        window: limit.windowSeconds,
        retryAfter: await this.redis.ttl(key)
      });
    }

    return { remaining: limit.maxRequests - current, total: limit.maxRequests };
  }
}
```

### WebSocket Scope

For persistent connections, tenant context is established once at connection time and wrapped around every message handler:

```javascript
wss.on('connection', (ws, req) => {
  const tenantId = extractTenantId(req);
  const tenant = { id: tenantId, connectionId: crypto.randomUUID() };

  ws.on('message', (raw) => {
    runWithTenant(tenant, async () => {
      const message = JSON.parse(raw);
      await handleMessage(message);  // getTenant() works throughout
    });
  });
});
```

## Implications

- AsyncLocalStorage adds ~2-5% overhead per async operation — negligible for I/O-bound workloads
- If any code spawns a detached async operation (e.g., `setTimeout` without wrapping), tenant context is lost
- The `getTenant()` call throws if called outside a request scope — this is intentional, making accidental global-scope data access fail loudly
- Database auto-scoping relies on every query going through the wrapper — raw queries bypass isolation
- Cached configuration must be invalidated when tenant settings change; stale cache duration is a trade-off
- Worker threads don't inherit AsyncLocalStorage context — tenant must be serialized and re-established

## Code Example

```javascript
// Express app setup with tenant isolation
import express from 'express';

const app = express();
const db = new TenantScopedDB(rawDb);
const config = new TenantConfig(configStore);
const rateLimiter = new TenantRateLimiter(redis);

app.use(tenantMiddleware);

app.post('/api/tasks', async (req, res) => {
  await rateLimiter.check('create_task');

  // No tenantId parameter anywhere — it's implicit
  const task = await db.insert('tasks', {
    title: req.body.title,
    status: 'pending'
  });

  const model = await selectModel('task_planning');
  const plan = await generatePlan(task, model);

  res.json({ task, plan });
});
```

## Related Patterns

- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
