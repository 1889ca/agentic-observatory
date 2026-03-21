# Declarative Socket Handler Factory

> Declarative handler definitions for Socket.io events with auto-validation, type coercion, cache invalidation, and broadcast support.

## Problem

Writing Socket.io event handlers manually means repeating validation, error handling, type coercion, and broadcast logic in every handler. Each handler independently implements the same boilerplate — check required fields, coerce string IDs to numbers, wrap errors in a consistent format, broadcast results to rooms, and invalidate relevant caches. This leads to inconsistent behavior across handlers and subtle bugs when one handler forgets a step.

## Context

Any project with many Socket.io event handlers that share common cross-cutting concerns: parameter validation, type coercion, error formatting, result broadcasting, and cache invalidation. Particularly relevant when handlers are authored by different developers or AI agents that may not remember every convention. Riley's `lib/socket-factory.js` provides the implementation.

## Solution

Three factory functions let you define handlers declaratively rather than imperatively:

### `defineHandler(event, schema, handlerFn)`

Wraps a single handler with auto-validation, type coercion, error wrapping, and optional broadcast/cache-invalidation config:

```javascript
// lib/socket-factory.js
const { defineHandler } = require('./socket-factory');

const updateTask = defineHandler('task:update', {
  params: {
    taskId: { type: 'number', required: true },
    title: { type: 'string' },
    status: { type: 'string', enum: ['open', 'in-progress', 'done'] },
  },
  broadcast: { room: 'project:{projectId}', event: 'task:updated' },
  invalidates: ['tasks:{projectId}', 'dashboard:{projectId}'],
}, async ({ taskId, title, status }, context) => {
  const task = await db.tasks.update(taskId, { title, status });
  return task;
});
```

The factory handles:
- **Validation** — rejects calls missing required params or violating enum constraints before the handler runs
- **Type coercion** — a `taskId` sent as `"42"` is coerced to `42` based on the schema type
- **Error wrapping** — uncaught errors return a consistent `{ error, code }` shape to the client
- **Broadcast** — on success, emits the result to the specified room with template interpolation (`{projectId}` resolved from params)
- **Cache invalidation** — on success, clears the listed cache keys (also template-interpolated)

### `defineHandlers(handlerMap)`

Batch-registers multiple handlers from an object map:

```javascript
const { defineHandlers } = require('./socket-factory');

const handlers = defineHandlers({
  'task:create': {
    params: {
      projectId: { type: 'number', required: true },
      title: { type: 'string', required: true },
    },
    broadcast: { room: 'project:{projectId}', event: 'task:created' },
    invalidates: ['tasks:{projectId}'],
    handler: async ({ projectId, title }, context) => {
      return db.tasks.create({ projectId, title });
    },
  },
  'task:delete': {
    params: {
      taskId: { type: 'number', required: true },
    },
    invalidates: ['tasks:{projectId}', 'dashboard:{projectId}'],
    handler: async ({ taskId }, context) => {
      return db.tasks.delete(taskId);
    },
  },
});
```

### `defineHandlerGroup(namespace, handlers)`

Groups related handlers under a namespace prefix, reducing repetition:

```javascript
const { defineHandlerGroup } = require('./socket-factory');

const taskHandlers = defineHandlerGroup('task', {
  create: {
    params: {
      projectId: { type: 'number', required: true },
      title: { type: 'string', required: true },
      priority: { type: 'number', default: 0 },
    },
    broadcast: { room: 'project:{projectId}', event: 'task:created' },
    invalidates: ['tasks:{projectId}'],
    handler: async ({ projectId, title, priority }) => {
      return db.tasks.create({ projectId, title, priority });
    },
  },
  update: {
    params: {
      taskId: { type: 'number', required: true },
      title: { type: 'string' },
      status: { type: 'string', enum: ['open', 'in-progress', 'done'] },
    },
    broadcast: { room: 'project:{projectId}', event: 'task:updated' },
    invalidates: ['tasks:{projectId}'],
    handler: async ({ taskId, title, status }) => {
      return db.tasks.update(taskId, { title, status });
    },
  },
  delete: {
    params: {
      taskId: { type: 'number', required: true },
    },
    invalidates: ['tasks:{projectId}', 'dashboard:{projectId}'],
    handler: async ({ taskId }) => {
      return db.tasks.delete(taskId);
    },
  },
});

// Registers: 'task:create', 'task:update', 'task:delete'
```

## Implications

- Declarative definitions reduce boilerplate significantly — each handler only contains its business logic, not infrastructure concerns
- Adds a layer of indirection: debugging requires understanding the factory's wrapping behavior, not just the handler code
- Schema validation catches malformed requests early, before the handler executes, producing consistent error responses
- Cache invalidation coupling means handlers implicitly depend on cache key naming conventions — renaming a cache key requires updating every handler that invalidates it
- Broadcast config uses template interpolation (`{projectId}`), which fails silently if the param isn't present in the handler's return value or input
- Type coercion is convenient but can mask client-side bugs — a client consistently sending string IDs never gets corrected

## Code Example

Complete registration of a handler group with socket attachment:

```javascript
const { defineHandlerGroup } = require('./socket-factory');

const noteHandlers = defineHandlerGroup('note', {
  create: {
    params: {
      projectId: { type: 'number', required: true },
      title: { type: 'string', required: true },
      content: { type: 'string', default: '' },
      tags: { type: 'array', default: [] },
    },
    broadcast: { room: 'project:{projectId}', event: 'note:created' },
    invalidates: ['notes:{projectId}'],
    handler: async ({ projectId, title, content, tags }) => {
      return db.notes.create({ projectId, title, content, tags });
    },
  },
  update: {
    params: {
      noteId: { type: 'number', required: true },
      title: { type: 'string' },
      content: { type: 'string' },
      tags: { type: 'array' },
    },
    broadcast: { room: 'project:{projectId}', event: 'note:updated' },
    invalidates: ['notes:{projectId}', 'note:{noteId}'],
    handler: async ({ noteId, title, content, tags }) => {
      return db.notes.update(noteId, { title, content, tags });
    },
  },
  search: {
    params: {
      projectId: { type: 'number', required: true },
      query: { type: 'string', required: true },
    },
    handler: async ({ projectId, query }) => {
      return db.notes.search(projectId, query);
    },
    // No broadcast or invalidation — read-only operation
  },
});

// Attach to socket server
function attachHandlers(io) {
  io.on('connection', (socket) => {
    noteHandlers.register(socket);
  });
}
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
