# Unified Event System

> A TypeScript event bus with namespaced emit/on pub/sub, wildcard subscriptions, debounced entity event batching, and key-based deduplication before delivery.

## Problem

A complex orchestrator has many moving parts — entity CRUD, job dispatching, model calls, capability execution — and multiple consumers that need to react to these changes. Without a unified event system, components poll for updates, miss state changes, or couple tightly to each other through direct function calls. High-frequency entity mutations can also flood subscribers with redundant updates when the same entity changes multiple times in quick succession.

## Context

- Multiple event producers: entity operations, job lifecycle, model dispatch, capability execution
- Multiple consumers: widget subscriptions, audit logging, reflex triggers
- All event types — entity changes and system events — need to flow through the same coordination layer
- Consumers may subscribe to specific event types, entity categories, or broad event namespaces
- Entity mutations can occur in bursts (e.g., bulk updates), requiring batching to avoid redundant subscriber notifications

## Solution

### Single Event Bus with Two Delivery Modes

All internal events flow through one event bus (`lib/unified-events.ts`). Event names are namespaced by convention. The bus supports two delivery modes:

1. **System events** — emitted immediately with no batching
2. **Entity events** — accumulated in a 50ms debounce window, deduplicated by key, then flushed to subscribers as a batch

```typescript
// System events — immediate delivery
bus.emit('system.job.started', { jobId: 'job-789', type: 'flow' });
bus.emit('system.model.error', { model: 'claude', error: 'timeout' });

// Entity events — debounced and deduplicated
bus.emitEntityChange('task', 'abc-123', tenantId, { status: 'done' });
bus.emitEntityChange('task', 'abc-123', tenantId, { status: 'reviewed' });
// Only the latest change for abc-123 is delivered after the 50ms window
```

### Debounced Entity Batching

Entity change events are accumulated in a pending `Map` keyed by `${tenantId}:${type}:${id}`. When the first entity event arrives, a 50ms timer starts. Subsequent events for the same key overwrite the previous entry (last-write-wins deduplication). When the timer fires, all accumulated changes are flushed to subscribers in a single batch.

```typescript
const DEBOUNCE_MS = 50;
const pending: Map<string, EntityChange> = new Map();
let flushTimer: NodeJS.Timeout | null = null;

function emitEntityChange(type: string, id: string, tenantId: number, data: any): void {
  const key = `${tenantId}:${type}:${id}`;
  pending.set(key, { type, id, tenantId, data, timestamp: Date.now() });

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const batch = Array.from(pending.values());
      pending.clear();
      flushTimer = null;
      handlers.get('entity.*')?.forEach((h) => h(batch));
      // Per-type handlers
      for (const change of batch) {
        handlers.get(`entity.${change.type}.*`)?.forEach((h) => h(change));
      }
    }, DEBOUNCE_MS);
  }
}
```

### Standard Pub/Sub API

Consumers subscribe using `on(eventName, handler)` and unsubscribe using `off(eventName, handler)`. Wildcard subscriptions match any event where the prefix matches.

```typescript
// Subscribe to all entity change batches
bus.on('entity.*', (batch) => {
  auditLog.recordBatch(batch);
});

// Subscribe to a specific entity type
bus.on('entity.task.*', (change) => {
  refreshWidget(change.id);
});

// Subscribe to system events
bus.on('system.*', (payload) => {
  diagnostics.track(payload);
});
```

### Event Payload Structure

Entity event payloads include `type`, `id`, `tenantId`, `data`, and `timestamp`. System event payloads are plain objects with relevant identifiers. Entity events delivered via the wildcard `entity.*` handler arrive as arrays (batches); per-type handlers receive individual change objects.

## Implications

- The 50ms debounce window means entity event delivery is not instantaneous — subscribers see changes after the window closes
- Last-write-wins deduplication means intermediate states are lost; only the final state within the window is delivered
- System events remain synchronous and immediate — no batching delay
- No event persistence — missed events during a process restart are lost; consumers must reconcile state on startup
- Wildcard subscribers to `entity.*` receive arrays and must handle batch iteration
- The deduplication key `${tenantId}:${type}:${id}` means different tenants' changes to the same entity ID are correctly separated

## Code Example

```typescript
// Bulk entity update — only final states are delivered
for (const task of tasks) {
  await entityStore.update(task.id, { status: 'done' });
  bus.emitEntityChange('task', task.id, tenantId, { status: 'done' });
}
// After 50ms, subscribers receive one batch with deduplicated changes
// If the same task was updated twice, only the last update is included
```

## Related Patterns

- [Debounced Entity Event Batching](./debounced-entity-event-batching.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Declarative Capability System](./declarative-capability-system.md)
