# Debounced Entity Event Batching

> Accumulate entity mutation events over a 50ms window and flush them as a single batch to prevent subscriber flooding during bulk operations.

## Problem

When bulk operations touch hundreds of entities in rapid succession, emitting an individual event per mutation causes subscribers to re-render or re-query on every single change. A subscriber processing 500 individual events sequentially will thrash the UI or overwhelm downstream consumers, even if it only needs the final state of each entity.

## Context

This pattern applies when:

- An event bus carries two classes of events: entity mutations (create, update, delete) and system events (errors, lifecycle signals)
- Bulk operations (imports, batch updates, cascading side effects) are common
- Subscribers care about the latest state of an entity, not every intermediate state it passed through
- The system is multi-tenant and tenant isolation must be preserved at the event level

It is implemented in `lib/unified-events.ts` as part of the Unified Event System.

## Solution

A `DEBOUNCE_MS = 50` constant controls the accumulation window. Incoming entity mutation events are stored in a `pending` Map rather than delivered immediately. The map key is `${tenantId}:${type}:${id}`, which enforces last-write-wins deduplication per entity per tenant.

When the first event arrives after the map is empty, a 50ms timer starts. Subsequent mutations within that window update the map in place — no new timer is started. When the timer fires, the entire map is drained and its values are delivered to subscribers as a single array of changes.

System events (errors, lifecycle) bypass this mechanism entirely and are delivered immediately.

## Implications

- **+50ms latency** is added to all entity mutation delivery. This is acceptable for UI updates but callers must not rely on synchronous delivery.
- **Intermediate states are lost.** If an entity is created and then immediately updated within the same window, subscribers only see the update. Code that depends on observing the create event will not work correctly.
- **Deduplication is last-write-wins.** The most recent change for a given key overwrites all prior changes for that key within the window.
- **Subscribers receive arrays.** The subscriber contract is `(changes: EntityChange[]) => void`, not a single-event callback. Existing subscribers must handle batch input.
- **Multi-tenant safe.** The `tenantId` prefix in the deduplication key ensures a change to entity `user:42` in tenant A never collides with the same entity in tenant B.

## Code Example

```ts
const DEBOUNCE_MS = 50;

// Keyed by `${tenantId}:${type}:${id}` — last write wins
const pending = new Map<string, EntityChange>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueEntityEvent(change: EntityChange): void {
  const key = `${change.tenantId}:${change.type}:${change.id}`;
  pending.set(key, change); // overwrites any prior change for this entity

  if (flushTimer === null) {
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }
}

function flush(): void {
  flushTimer = null;
  const batch = Array.from(pending.values());
  pending.clear();
  notifySubscribers(batch);
}

function emitEvent(event: UnifiedEvent): void {
  if (event.kind === 'entity') {
    enqueueEntityEvent(event.change);
  } else {
    // System events are delivered immediately, no batching
    notifySubscribers([event]);
  }
}
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
