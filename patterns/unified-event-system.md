# Unified Event System

> A single pub/sub event bus for all internal events, using namespaced event names and standard emit/on patterns to coordinate widgets, audit logging, and reflex triggers.

## Problem

A complex orchestrator has many moving parts — entity CRUD, job dispatching, model calls, capability execution — and multiple consumers that need to react to these changes. Without a unified event system, components poll for updates, miss state changes, or couple tightly to each other through direct function calls.

## Context

- Multiple event producers: entity operations, job lifecycle, model dispatch, capability execution
- Multiple consumers: widget subscriptions, audit logging, reflex triggers
- All event types — entity changes and system events — need to flow through the same coordination layer
- Consumers may subscribe to specific event types, entity categories, or broad event namespaces

## Solution

### Single Event Bus

All internal events flow through one event bus (`lib/event-bus/index.js`). There is no separation between entity events and system events — both are emitted immediately with no batching or debouncing. Event names are namespaced by convention to organize them and enable wildcard subscriptions.

```typescript
// Entity events
bus.emit('entity.task.updated', { entityId: 'abc-123', data: { status: 'done' } });
bus.emit('entity.task.created', { entityId: 'xyz-456', data: { title: 'New task' } });

// System events
bus.emit('system.job.started', { jobId: 'job-789', type: 'flow' });
bus.emit('system.model.error', { model: 'claude', error: 'timeout' });
```

Events are emitted synchronously. There is no 50ms debounce window, no batching, and no deduplication — each call to `emit` delivers immediately to all registered handlers.

### Standard Pub/Sub API

Consumers subscribe using `on(eventName, handler)` and unsubscribe using `off(eventName, handler)`. The API is intentionally minimal.

```typescript
// Subscribe to a specific event
bus.on('entity.task.updated', (payload) => {
  refreshWidget(payload.entityId);
});

// Subscribe to all entity events via wildcard
bus.on('entity.*', (payload) => {
  auditLog.record(payload);
});

// Subscribe to all system events
bus.on('system.*', (payload) => {
  diagnostics.track(payload);
});

// Unsubscribe
bus.off('entity.task.updated', handler);
```

Wildcard subscriptions match any event name where the prefix before `.*` equals the corresponding segment of the emitted event name.

### Internal Event Fan-Out

Events are consumed entirely within the process. When an entity operation completes or a job changes state, the relevant module calls `bus.emit(...)` and all registered local subscribers receive the payload — widgets that need to refresh, audit logging that needs to record, reflex triggers that need to evaluate conditions. There is no Socket.io broadcast layer in the event bus itself.

```typescript
// After completing an entity write
await entityStore.update(entityId, data);
bus.emit('entity.task.updated', { entityId, data, source: 'flow:maintain' });
// All subscribers fire immediately
```

### Event Payload Structure

Event payloads are plain objects. Producers include whatever fields are relevant to their consumers. There is no enforced envelope schema, but by convention entity events include `entityId`, `data`, and `source`, and system events include relevant identifiers for the operation.

```typescript
// Typical entity event payload
{
  entityId: 'abc-123',
  data: { title: 'Updated title', status: 'done' },
  source: 'flow:maintain',
  timestamp: 1741689600000
}

// Typical system event payload
{
  jobId: 'job-789',
  type: 'flow',
  status: 'started',
  timestamp: 1741689600000
}
```

## Implications

- Events fire synchronously within the event loop — slow handlers block delivery to subsequent subscribers
- No event persistence — missed events during a process restart are lost; consumers must reconcile state on startup
- No guaranteed ordering across different namespaces
- Wildcard subscriptions match broadly — consumers are responsible for filtering payloads they care about
- Event volume scales with system activity — high-throughput flows can generate many events per second with no built-in backpressure

## Code Example

```typescript
// lib/event-bus/index.js — simplified implementation
const handlers: Map<string, Set<Function>> = new Map();

export function on(eventName: string, handler: Function): void {
  if (!handlers.has(eventName)) {
    handlers.set(eventName, new Set());
  }
  handlers.get(eventName)!.add(handler);
}

export function off(eventName: string, handler: Function): void {
  handlers.get(eventName)?.delete(handler);
}

export function emit(eventName: string, payload: unknown): void {
  // Exact match
  handlers.get(eventName)?.forEach((h) => h(payload));

  // Wildcard match: 'entity.*' matches 'entity.task.updated'
  const prefix = eventName.split('.')[0];
  const wildcard = `${prefix}.*`;
  if (wildcard !== eventName) {
    handlers.get(wildcard)?.forEach((h) => h(payload));
  }
}
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Declarative Capability System](./declarative-capability-system.md)
