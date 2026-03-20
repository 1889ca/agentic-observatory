# Multi-Tenant Session Isolation

> Tenant-scoped Socket.io rooms with per-tenant state objects and tenant ID validation on every event handler to prevent cross-tenant data leakage.

## Problem

In a multi-tenant orchestrator, all clients share the same server process and the same Socket.io instance. Without explicit isolation, a broadcast or a state lookup can accidentally reach sessions belonging to a different tenant. A single missing filter in one event handler is enough to expose one tenant's work to another.

## Context

This pattern applies whenever multiple independent tenants share a real-time server. It is the structural enforcement layer that makes tenant boundaries hard to accidentally violate — relying on developer discipline alone is not sufficient at scale or under time pressure.

## Solution

On connection, each socket is placed into a room named after its tenant ID. All server-to-client emissions target a room, never a raw socket or the global namespace. Per-tenant state is stored in a map keyed by tenant ID, and all access to that map goes through a single `getState(tenantId)` accessor that validates the ID before returning the slice. Every event handler extracts the tenant ID from the verified socket context and rejects any event that attempts to act on a different tenant's resources.

```js
// lib/server/state.js

const tenantState = new Map();

function getState(tenantId) {
  if (!tenantId) throw new Error('tenantId required');
  if (!tenantState.has(tenantId)) {
    tenantState.set(tenantId, {
      sessions: new Map(),
      activeFlows: new Map(),
      metadata: {},
    });
  }
  return tenantState.get(tenantId);
}

function destroyState(tenantId) {
  tenantState.delete(tenantId);
}

module.exports = { getState, destroyState };
```

```js
// lib/server/socket.js

const { getState } = require('./state');

function registerHandlers(io) {
  io.on('connection', (socket) => {
    const { tenantId, userId } = socket.handshake.auth;

    if (!tenantId) {
      socket.disconnect(true);
      return;
    }

    // Isolate this socket inside its tenant's room
    const room = `tenant:${tenantId}`;
    socket.join(room);

    const state = getState(tenantId);
    state.sessions.set(socket.id, { userId, connectedAt: Date.now() });

    socket.on('flow:start', (payload) => {
      // Reject cross-tenant attempts — payload.tenantId must match the socket's own tenant
      if (payload.tenantId && payload.tenantId !== tenantId) {
        socket.emit('error', { code: 'TENANT_MISMATCH' });
        return;
      }
      // All work scoped to this tenant's state only
      const tenantFlows = getState(tenantId).activeFlows;
      startFlow(tenantFlows, payload);
    });

    socket.on('disconnect', () => {
      state.sessions.delete(socket.id);
      socket.leave(room);
    });
  });
}

// Emit to all sessions belonging to a tenant — never to raw sockets or global
function emitToTenant(io, tenantId, event, data) {
  io.to(`tenant:${tenantId}`).emit(event, data);
}

module.exports = { registerHandlers, emitToTenant };
```

The data access layer mirrors this: any query that accepts a `tenantId` parameter validates that it matches the caller's verified context before executing, preventing a crafted payload from reading another tenant's rows.

```js
// lib/db/flows.js

async function getFlowsByTenant(tenantId, requestingTenantId) {
  if (tenantId !== requestingTenantId) {
    throw new Error('Cross-tenant query blocked');
  }
  return db.query('SELECT * FROM flows WHERE tenant_id = $1', [tenantId]);
}

module.exports = { getFlowsByTenant };
```

## Implications

- Room-per-tenant prevents broadcast leakage but does not prevent a compromised socket from joining an arbitrary room if room names are predictable. Room names must not be guessable by clients — use opaque IDs, not sequential integers.
- The `getState` accessor creates a state object on first access. Long-lived processes accumulate stale state for disconnected tenants unless `destroyState` is called when the last session for a tenant disconnects.
- Cross-tenant validation at the event handler layer is a second line of defense, not the primary one. The primary defense is that the socket's `tenantId` is set at connection time from a verified auth token — never from client-supplied payload fields.
- Per-tenant state objects in memory do not survive server restarts. Persistent tenant state must be backed by the database; the in-memory map is a performance cache only.
- This pattern does not cover row-level security in the database. Both layers are necessary: room isolation stops real-time leakage, RLS stops persistence-layer leakage.

## Code Example

```js
// Sending a flow update to all of a tenant's connected sessions
const { emitToTenant } = require('../lib/server/socket');

async function onFlowCompleted(io, tenantId, flowResult) {
  // Only sessions in room `tenant:<tenantId>` receive this
  emitToTenant(io, tenantId, 'flow:completed', flowResult);
}
```

## Related Patterns

- [Request-Scoped Context Propagation](./request-scoped-context.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
