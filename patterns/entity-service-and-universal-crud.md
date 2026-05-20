# Entity Service and Universal CRUD

> Type-routed CRUD facade that dispatches to two storage backends (task-like vs. document) while normalizing inputs and outputs into a single canonical shape.

## Problem

A system with twenty entity types (task, goal, project, person, client, note, area, event, recipe, …) needs CRUD. Writing separate services per type produces inconsistent semantics — different normalization, different return shapes, different event emission, different validation strictness. Worse, some entities are task-like (status lifecycle, due dates, completion) while others are pure structured documents — they need different storage but callers should not have to care.

## Context

- An application manages many entity types with overlapping but non-identical lifecycles
- Some entities have a status machine and time-bounds (task, goal); most do not (note, person, project)
- All entity mutations should flow through one chokepoint so caches, events, and audits are consistent
- Aliases ("todo" → "task", "person" → "contact") arrive from LLM-generated calls and external imports
- Strict validation matters for some types (tasks) but would block legitimate creates for others

## Solution

A single entity service (`lib/entity-service.js` — a thin re-export shim over `lib/entity-service/`) provides universal CRUD by routing each call to one of two storage backends and normalizing the result into a canonical shape.

### Two-Backend Routing

`STORAGE_ROUTES` is a static map from entity type to one of two backends:

- `document-tasks` — task-like entities with status lifecycle: `task`, `goal`, `limitation`, `worker_task`
- `documents` — structured knowledge: `bill`, `project`, `person`, `client`, `event`, `note`, `area`, `organization`, `recipe`, `image`, `video`, `concept`, `tool`, `booking`, `gig`, …

```typescript
// lib/entity-service/routing.ts
export const STORAGE_ROUTES: Record<string, StorageBackend> = {
  task: 'document-tasks',
  goal: 'document-tasks',
  limitation: 'document-tasks',
  worker_task: 'document-tasks',
  project: 'documents',
  person: 'documents',
  area: 'documents',     // migrated from dedicated table Jan 2026
  // ...
}
```

`fact` is intentionally NOT routed through entity-service — facts use a separate triple-store (`lib/unified-memory/facts.js`) because subject-predicate-object semantics differ from row-oriented CRUD.

### Alias Resolution

Aliases let LLM-generated calls and natural language flow through unchanged:

```typescript
export const TYPE_ALIASES: Record<string, string> = {
  contact: 'person',
  customer: 'client',
  todo: 'task',
  action: 'task',
  reminder: 'task',
  appointment: 'event',
  meeting: 'event',
  initiative: 'project',
  journal: 'note',
  doc: 'document',
}

export function resolveType(entityType: string): string {
  return TYPE_ALIASES[entityType] || entityType
}
```

### Output Normalization

Each backend stores rows in its own shape (document-tasks has top-level `dueAt`/`status`/`completedAt`; documents nests everything under `data`). `normalizeEntity` collapses both into one canonical output so callers don't branch:

```typescript
export function normalizeEntity(entity: RawEntity | null, entityType: string): NormalizedEntity | null {
  if (!entity) return null
  const type = resolveType(entityType)

  // document-tasks shape — task-like
  if (entity.dueAt !== undefined || entity.completedAt !== undefined) {
    return {
      id: entity.id, type, title: entity.title,
      status: entity.status, priority: entity.priority,
      dueAt: entity.dueAt, completedAt: entity.completedAt,
      tenantId: entity.tenantId ?? entity.tenant_id,
      createdAt: entity.createdAt ?? entity.created_at,
      updatedAt: entity.updatedAt ?? entity.updated_at,
      data: entity.data || {},
    }
  }

  // documents shape — knowledge
  return {
    id: entity.id,
    type: entity.type || type,
    title: entity.title || entity.data?.name || entity.data?.title,
    tenantId: entity.tenant_id ?? entity.tenantId,
    createdAt: entity.created_at,
    updatedAt: entity.updated_at,
    data: entity.data || {},
  }
}
```

### Strict vs. Permissive Validation

`STRICT_VALIDATION_TYPES` lists types that block on schema failure. Non-strict types log a warning and accept the create — this prevents the LLM from getting stuck when it produces a partially-valid `note` but should never silently store a malformed `task`.

### Function-Based Facade

The top-level shim (`lib/entity-service.js`) re-exports a flat function API — no classes, no `new`:

```javascript
// lib/entity-service.js (auto-generated from .ts)
exports.create = require('./entity-service/crud').create
exports.read = require('./entity-service/crud').read
exports.update = require('./entity-service/crud').update
exports.remove = require('./entity-service/crud').remove
exports.list = require('./entity-service/crud').list
exports.complete = require('./entity-service/batch').complete
exports.reopen = require('./entity-service/batch').reopen
exports.archive = require('./entity-service/batch').archive
exports.getMany = require('./entity-service/batch').getMany
exports.updateMany = require('./entity-service/batch').updateMany
exports.deleteMany = require('./entity-service/batch').deleteMany
exports.getSupportedTypes = require('./entity-service/batch').getSupportedTypes
exports.isValidType = require('./entity-service/batch').isValidType
exports.getCanonicalType = require('./entity-service/batch').getCanonicalType
exports.STORAGE_ROUTES = require('./entity-service/routing').STORAGE_ROUTES
exports.delete = require('./entity-service/crud').remove  // backward-compat alias
```

## Implications

- Adding a new entity type is one line in `STORAGE_ROUTES` plus (optionally) one line in `TYPE_ALIASES` — no new service, no new normalizer required to start
- Two backends means two SQL shapes to keep in sync; the normalizer absorbs the divergence at read time so callers never see it
- `getInvalidationKeys` lets the cache layer key off entity changes uniformly; one event emission point means audit and websocket-fanout stay coherent
- Permissive validation on non-strict types trades correctness for forward progress — useful when the entity is mostly downstream-consumed by humans (notes) but dangerous if downstream code blindly trusts shape
- The thin `.js` shim over `.ts` source keeps CommonJS callers working without a TypeScript build at runtime; backward-compat `delete` alias survives because rename-everything refactors are not free
- `fact` being out-of-band is a load-bearing exception, not an oversight — triple-store semantics don't fit the row-CRUD model

## Code Example

```javascript
const entities = require('./lib/entity-service')

// Alias resolves automatically — 'todo' → 'task' → document-tasks backend
const task = await entities.create('todo', {
  title: 'Fix bug',
  dueAt: '2026-06-01T17:00:00Z',
  priority: 1,
})
// Returns normalized: { id, type: 'task', title, status, dueAt, completedAt, ... }

// Lifecycle helpers wrap update for common transitions
await entities.complete('task', task.id)
await entities.reopen('task', task.id)
await entities.archive('task', task.id)

// Same API for a non-task type — routes to documents backend
const project = await entities.create('project', {
  name: 'Q3 launch',
  description: 'Ship the new dashboard',
})

// Bulk reads don't care about backend split
const items = await entities.getMany('task', [task.id, otherId])
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
- [Document Type System](./document-type-system.md)
- [Database Abstraction and Schema Management](./database-abstraction-and-schema-management.md)
