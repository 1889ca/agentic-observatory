# Unified Event System

> Dual-mode event bus with debounced entity events and immediate system events for reactive UI and inter-component coordination.

## Problem

A complex orchestrator has many moving parts — entity CRUD, job dispatching, model calls, capability execution — and multiple consumers that need to react to these changes. Without a unified event system, components poll for updates, miss state changes, or couple tightly to each other through direct function calls.

## Context

- Multiple event producers: entity operations, job lifecycle, model dispatch, capability execution
- Multiple consumers: real-time UI (via WebSocket), widget subscriptions, audit logging, reflex triggers
- Entity changes are bursty (batch imports, flow steps) and need debouncing
- System events (job completion, model errors) are time-sensitive and need immediate delivery
- Consumers may subscribe to specific event types or entity categories

## Solution

### Two Event Modes

The event system provides two distinct delivery semantics:

**Entity Events** (debounced, batched) — Created, updated, deleted, archived events for data entities. These are debounced at 50ms to collapse rapid successive updates (e.g., a flow step that creates 5 entities) into a single notification batch.

```typescript
// Entity events via unified API
unified.entity.created('task', entityId, data);
unified.entity.updated('task', entityId, data);
unified.entity.deleted('task', entityId);
unified.entity.archived('task', entityId);
// Each call pushes to a pending batch, flushed after 50ms debounce
```

**System Events** (immediate, pub/sub) — Job lifecycle, model dispatch, capability execution, and other infrastructure events. These fire immediately with no batching.

```typescript
// System events also go through the unified API
unified.system.emit('job.started', event);
unified.system.emit('model.error', event);
// Fires immediately — no debouncing
```

### Event Payload Structure

All events share a common envelope:

```typescript
{
  entityType: 'task',
  action: 'updated',
  entityId: 'abc-123',
  data: { title: 'Updated title', status: 'done' },
  source: 'flow:maintain',
  invalidationKeys: ['widget:task-list', 'widget:dashboard'],
  timestamp: 1741689600000
}
```

The `invalidationKeys` field allows widgets to subscribe to specific cache invalidation signals rather than filtering every event.

### Widget Subscriptions

UI widgets register interest in specific entity types or invalidation keys. When a matching event fires, the widget receives a refresh signal:

```typescript
// Widget subscribes to task changes
unified.entity.on('updated', (event) => {
  if (event.invalidationKeys.includes(myWidgetKey)) {
    refreshWidget();
  }
});
```

### Internal Event Fan-Out

Entity events are emitted internally rather than broadcast over Socket.io. When the debounce window flushes, the system emits `entity.invalidated` events that local subscribers (widgets, audit logging, reflex triggers) consume directly within the process.

## Implications

- 50ms debounce adds latency to entity event delivery — fast enough for UI, but not for real-time coordination
- System events are synchronous within the event loop — slow handlers block delivery
- No event persistence — missed events during disconnection are lost (consumers must reconcile on reconnect)
- Invalidation keys couple event producers to widget naming — changes to widget keys require updating emitters
- Event volume scales with system activity — high-throughput flows can generate hundreds of events per second
- No guaranteed ordering across different entity types

## Code Example

```typescript
// Batch flush — collapses rapid updates
function flushBatch(): void {
  const batch = pendingEvents.splice(0);
  if (batch.length === 0) return;

  // Deduplicate: keep last event per entityId
  const deduped = new Map<string, EntityEvent>();
  for (const event of batch) {
    deduped.set(`${event.entityType}:${event.entityId}`, event);
  }

  // Emit internal invalidation events to local subscribers
  for (const event of deduped.values()) {
    emit('entity.invalidated', event);
  }
}
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Declarative Capability System](./declarative-capability-system.md)
