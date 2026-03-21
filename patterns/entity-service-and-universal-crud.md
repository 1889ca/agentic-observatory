# Entity Service and Universal CRUD

> Universal CRUD abstraction for all entity types with type normalization, alias resolution, and automatic event emission.

## Problem

Every entity type (contacts, tasks, documents, projects) needs CRUD operations. Writing separate services for each leads to inconsistent behavior — some emit events, some don't; some normalize input, some don't; some support batch operations, some don't. The result is a patchwork of ad-hoc services with subtly different semantics.

## Context

- An application manages many entity types that share common CRUD patterns
- All mutations should emit events for downstream consumers (UI, audit, reflexes)
- Input data arrives in inconsistent shapes from different sources (API, LLM, imports)
- Batch operations are common (flow steps, bulk imports) and need transaction semantics
- Entity types may be referenced by aliases ("person" → "contact", "todo" → "task")

## Solution

A single entity service (`lib/entity-service.js`) provides universal CRUD for any registered entity type, composed from four submodules:

### Type Normalization (normalize submodule)

Incoming entity data is normalized before any operation. Each entity type registers a normalizer that standardizes field names, coerces types, and applies defaults:

```javascript
// lib/entity-service/normalize.js
const normalizers = new Map();

function registerNormalizer(entityType, fn) {
  normalizers.set(entityType, fn);
}

function normalize(entityType, data) {
  const fn = normalizers.get(entityType);
  if (!fn) return data;
  return fn(data);
}

// Example: contact normalizer
registerNormalizer('contact', (data) => ({
  name: data.name || data.full_name || data.displayName || '',
  email: (data.email || '').toLowerCase().trim(),
  phone: data.phone || data.tel || null,
  tags: Array.isArray(data.tags) ? data.tags : [],
  created_at: data.created_at || new Date().toISOString(),
}));
```

### Alias Resolution (routing submodule)

The routing submodule resolves aliases before dispatching to CRUD operations, so callers can use natural names:

```javascript
// lib/entity-service/routing.js
const aliases = new Map();

function registerAlias(alias, canonicalType) {
  aliases.set(alias, canonicalType);
}

function resolve(type) {
  return aliases.get(type) || type;
}

// Registration
registerAlias('person', 'contact');
registerAlias('todo', 'task');
registerAlias('doc', 'document');
```

### Universal CRUD (crud submodule)

Standard create/read/update/delete operations that work for any registered entity type. Operations automatically validate, normalize, persist, and emit events:

```javascript
// lib/entity-service/crud.js
const { resolve } = require('./routing');
const { normalize } = require('./normalize');
const events = require('../events');

async function create(type, data) {
  const resolved = resolve(type);
  const normalized = normalize(resolved, data);
  // validate against schema, throw on failure
  const entity = await db.insert(resolved, normalized);
  events.emit('entity.created', { type: resolved, entity });
  return entity;
}

async function update(type, id, data) {
  const resolved = resolve(type);
  const normalized = normalize(resolved, data);
  const entity = await db.update(resolved, id, normalized);
  events.emit('entity.updated', { type: resolved, entity });
  return entity;
}

async function remove(type, id) {
  const resolved = resolve(type);
  await db.delete(resolved, id);
  events.emit('entity.deleted', { type: resolved, id });
}
```

### Batch Operations (batch submodule)

Bulk create, update, and delete with transaction wrapping and partial failure handling. Each operation in the batch runs independently — failures are collected, not thrown:

```javascript
// lib/entity-service/batch.js
const crud = require('./crud');

async function batchCreate(type, items) {
  const results = { succeeded: [], failed: [] };

  await db.transaction(async (tx) => {
    for (const item of items) {
      try {
        const entity = await crud.create(type, item, { tx });
        results.succeeded.push(entity);
      } catch (err) {
        results.failed.push({ item, error: err.message });
      }
    }
  });

  return results;
}
```

### Service Facade

The top-level entity service composes the submodules into a unified API:

```javascript
// lib/entity-service.js
const crud = require('./entity-service/crud');
const batch = require('./entity-service/batch');
const { registerNormalizer } = require('./entity-service/normalize');
const { registerAlias } = require('./entity-service/routing');

module.exports = {
  create: crud.create,
  read: crud.read,
  update: crud.update,
  delete: crud.remove,
  batchCreate: batch.batchCreate,
  batchUpdate: batch.batchUpdate,
  batchDelete: batch.batchDelete,
  registerNormalizer,
  registerAlias,
};
```

## Implications

- Single service reduces code but becomes a bottleneck if it grows too complex — the submodule split mitigates this by keeping each concern isolated
- Automatic event emission ensures downstream systems always hear about changes, but means every CRUD call has event overhead even when no one is listening
- Alias resolution simplifies the API surface but can create confusion about canonical names — callers may not know whether "person" or "contact" is the real type
- Batch operations with partial failure handling are essential — bulk imports rarely succeed 100%, and the caller needs to know what failed and why
- Normalizers are registered per-type, so adding a new entity type requires writing a normalizer or accepting raw data passthrough
- The facade pattern keeps the public API flat while the internals stay modular

## Code Example

```javascript
const entityService = require('./lib/entity-service');

// Register a new entity type
entityService.registerAlias('todo', 'task');
entityService.registerNormalizer('task', (data) => ({
  title: data.title || data.name || 'Untitled',
  status: data.status || 'pending',
  priority: Number(data.priority) || 3,
}));

// Single operations — alias resolves automatically
const task = await entityService.create('todo', { name: 'Fix bug', priority: '1' });
// → normalized to { title: 'Fix bug', status: 'pending', priority: 1 }
// → emits entity.created { type: 'task', entity: { id: '...', ... } }

await entityService.update('task', task.id, { status: 'done' });
// → emits entity.updated

// Batch operations
const results = await entityService.batchCreate('task', [
  { title: 'Task A' },
  { title: 'Task B' },
  { /* invalid — missing required fields */ },
]);
// → results.succeeded: [taskA, taskB]
// → results.failed: [{ item: {}, error: 'title is required' }]
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
- [Declarative Socket Handler Factory](./declarative-socket-handler-factory.md)
