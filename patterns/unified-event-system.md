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

```javascript
// Entity event with batching
function emitEntityEvent(action, entityType, entityId, data) {
  pendingEvents.push({
    action,       // 'created' | 'updated' | 'deleted' | 'archived'
    entityType,   // 'task' | 'note' | 'project' | ...
    entityId,
    data,
    source: currentContext(),
    timestamp: Date.now()
  });
  scheduleBatchFlush(50); // Debounce 50ms
}
```

**System Events** (immediate, pub/sub) — Job lifecycle, model dispatch, capability execution, and other infrastructure events. These fire immediately with no batching.

```javascript
// System event — fires immediately
function emitSystemEvent(channel, event) {
  // channel: 'job.started', 'model.error', 'capability.executed'
  subscribers.get(channel)?.forEach(handler => handler(event));
}
```

### Event Payload Structure

All events share a common envelope:

```javascript
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

```javascript
// Widget subscribes to task changes
subscribe('entity:updated', (event) => {
  if (event.invalidationKeys.includes(myWidgetKey)) {
    refreshWidget();
  }
});
```

### Event Fan-Out via WebSocket

Entity events are broadcast to connected clients over Socket.io for real-time UI updates. The gateway bridges events from the brain process to client connections, ensuring UI reactivity survives brain restarts.

## Implications

- 50ms debounce adds latency to entity event delivery — fast enough for UI, but not for real-time coordination
- System events are synchronous within the event loop — slow handlers block delivery
- No event persistence — missed events during disconnection are lost (consumers must reconcile on reconnect)
- Invalidation keys couple event producers to widget naming — changes to widget keys require updating emitters
- Event volume scales with system activity — high-throughput flows can generate hundreds of events per second
- No guaranteed ordering across different entity types

## Code Example

```javascript
// Batch flush — collapses rapid updates
function flushBatch() {
  const batch = pendingEvents.splice(0);
  if (batch.length === 0) return;

  // Deduplicate: keep last event per entityId
  const deduped = new Map();
  for (const event of batch) {
    deduped.set(`${event.entityType}:${event.entityId}`, event);
  }

  // Deliver to local subscribers
  for (const event of deduped.values()) {
    emitSystemEvent(`entity:${event.action}`, event);
  }

  // Broadcast to connected clients
  io.emit('entity:batch', Array.from(deduped.values()));
}
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Declarative Capability System](./declarative-capability-system.md)
