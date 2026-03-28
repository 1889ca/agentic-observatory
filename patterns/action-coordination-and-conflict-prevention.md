# Action Coordination and Conflict Prevention

> Reversible action buffer with TTL-based undo windows, domain-specific undo handlers, and auto-finalization -- enabling a "trust but verify" autonomy model where the agent acts first and the user can revert.

## Problem

An autonomous agent that can take actions -- archiving emails, creating tasks, labeling messages, scheduling events -- needs a mechanism for users to reverse mistakes without manual intervention. The traditional approach of requiring approval before every action is too slow and creates bottlenecks. But executing irreversibly means any mistake requires manual cleanup. The agent needs to act decisively while giving users a safety net.

## Context

- An AI agent with autonomous capabilities that execute real actions (email operations, task management, calendar changes)
- Some operations are inherently reversible (archive/unarchive, label/unlabel, create/delete)
- Users expect responsive autonomy -- the agent should act, not ask permission for routine operations
- A configurable window gives users time to review and revert before actions become permanent
- The system needs to track what can be undone and execute domain-specific reversal logic

## Solution

### Reversible Action Type Registry

Each reversible action type declares its inverse operation and default TTL (time-to-live before auto-finalization):

```javascript
// lib/agent/action-buffer/types.js
const DEFAULT_TTL_SECONDS = 300; // 5 minutes

const REVERSIBLE_ACTIONS = {
  // Email operations
  'email.archive':    { undoAction: 'email.unarchive', ttl: 300 },
  'email.unarchive':  { undoAction: 'email.archive', ttl: 300 },
  'email.label':      { undoAction: 'email.removeLabel', ttl: 300 },
  'email.removeLabel':{ undoAction: 'email.label', ttl: 300 },
  'email.markRead':   { undoAction: 'email.markUnread', ttl: 300 },
  'email.star':       { undoAction: 'email.unstar', ttl: 300 },

  // Draft operations (longer TTL -- drafts take time to review)
  'draft.create':     { undoAction: 'draft.delete', ttl: 600 },
  'draft.update':     { undoAction: 'draft.restore', ttl: 600 },

  // Task operations
  'task.create':      { undoAction: 'task.delete', ttl: 300 },
  'task.complete':    { undoAction: 'task.uncomplete', ttl: 300 },
  'task.archive':     { undoAction: 'task.unarchive', ttl: 300 },
  'task.prioritize':  { undoAction: 'task.deprioritize', ttl: 300 },

  // Calendar, reminder, document operations...
  'event.create':     { undoAction: 'event.delete', ttl: 300 },
  'reminder.create':  { undoAction: 'reminder.cancel', ttl: 300 },
  'note.create':      { undoAction: 'note.delete', ttl: 300 },
};

function isReversible(actionType) {
  return actionType in REVERSIBLE_ACTIONS;
}

function getUndoAction(actionType) {
  return REVERSIBLE_ACTIONS[actionType]?.undoAction || null;
}
```

### DB-Backed Action Buffer

When a reversible action is executed, it's recorded in an `action_buffer` table with the undo payload and an expiration timestamp:

```javascript
// lib/agent/action-buffer/buffer.js
async function bufferAction({ actionType, actionId, description, undoPayload, ttlSeconds, metadata = {} }) {
  if (!isReversible(actionType)) {
    throw new Error(`Action type '${actionType}' is not reversible`);
  }

  const expiresAt = new Date(Date.now() + (ttlSeconds || getDefaultTTL(actionType)) * 1000);

  const id = await insert('action_buffer', {
    tenant_id: tenantId,
    action_type: actionType,
    action_id: actionId,
    description,
    undo_payload: JSON.stringify(undoPayload),
    undo_action: getUndoAction(actionType),
    buffered_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'buffered', // buffered -> undone | finalized
    metadata: JSON.stringify(metadata),
  });

  audit.log('action_buffer:buffered', { bufferId: id, actionType, description, expiresAt });
  return id;
}
```

### Domain-Specific Undo Handlers

Undo execution dispatches to domain-specific handlers based on the action type prefix. Each handler knows how to reverse its domain's operations:

```javascript
// lib/agent/action-buffer/undo.js
async function executeUndo(actionType, undoAction, undoPayload) {
  const [service] = actionType.split('.');

  switch (service) {
    case 'email': {
      const google = require('../../google');
      return executeEmailUndo(undoAction, undoPayload, google);
    }
    case 'task': {
      const tasksV2 = require('../../document-tasks');
      return executeTaskUndo(undoAction, undoPayload, tasksV2);
    }
    case 'document':
    case 'note': {
      const documents = require('../../documents');
      return executeDocumentUndo(undoAction, undoPayload, documents);
    }
    // ... event, reminder, draft handlers
  }
}

// lib/agent/action-buffer/undo-handlers.js
async function executeEmailUndo(undoAction, payload, google) {
  const { messageId, labelIds } = payload;

  switch (undoAction) {
    case 'email.unarchive':
      await google.gmail.modifyLabels(messageId, ['INBOX'], ['ARCHIVE']);
      return { restored: messageId };

    case 'email.removeLabel':
      await google.gmail.modifyLabels(messageId, [], labelIds);
      return { removedLabels: labelIds };

    case 'email.markUnread':
      await google.gmail.modifyLabels(messageId, ['UNREAD'], []);
      return { markedUnread: messageId };
    // ...
  }
}

async function executeTaskUndo(undoAction, payload, tasksV2) {
  const { taskId, previousState } = payload;

  switch (undoAction) {
    case 'task.delete':
      await tasksV2.remove(taskId);
      return { deleted: taskId };

    case 'task.uncomplete':
      await tasksV2.update(taskId, { status: 'pending' });
      return { uncompleted: taskId };

    case 'task.unarchive':
      await tasksV2.update(taskId, { status: previousState?.status || 'pending' });
      return { unarchived: taskId };
  }
}
```

### Undo Execution with Window Enforcement

The undo operation checks the TTL window before executing, auto-finalizing if the window has expired:

```javascript
async function undoAction(bufferId) {
  const action = await select('action_buffer')
    .where('id = ?', bufferId)
    .where("status = 'buffered'")
    .one();

  if (!action) {
    return { success: false, message: 'Buffered action not found or already processed' };
  }

  // Check if still within undo window
  if (new Date(action.expires_at) < new Date()) {
    await update('action_buffer', { status: 'finalized' }, 'id = ?', bufferId);
    return { success: false, message: 'Undo window has expired' };
  }

  const undoPayload = JSON.parse(action.undo_payload);
  const result = await executeUndo(action.action_type, action.undo_action, undoPayload);

  await update('action_buffer', {
    status: 'undone',
    undone_at: new Date().toISOString(),
  }, 'id = ?', bufferId);

  return { success: true, message: `Undone: ${action.description}`, undone: result };
}
```

### Auto-Finalization and Maintenance

A periodic maintenance job finalizes expired buffered actions and cleans up old records:

```javascript
// lib/agent/action-buffer/maintenance.js
async function finalizeExpired() {
  const now = new Date().toISOString();
  const result = await raw(
    `UPDATE action_buffer
     SET status = 'finalized', finalized_at = $1
     WHERE status = 'buffered' AND expires_at <= $2
     RETURNING id`,
    [now, now]
  );
  return result.length;
}

async function cleanup(daysOld = 7) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const result = await raw(
    `DELETE FROM action_buffer
     WHERE status IN ('finalized', 'undone')
       AND COALESCE(finalized_at, undone_at) < $1
     RETURNING id`,
    [cutoff]
  );
  return result.length;
}
```

### Querying Buffered Actions

Users and the UI can see what's currently undoable, with remaining time displayed:

```javascript
async function getBufferedActions(options = {}) {
  const actions = await select('action_buffer')
    .where("status = 'buffered'")
    .where('expires_at > ?', new Date().toISOString())
    .orderBy('buffered_at DESC')
    .all();

  return actions.map((a) => ({
    id: a.id,
    actionType: a.action_type,
    description: a.description,
    remainingSeconds: Math.max(0, Math.round((new Date(a.expires_at) - new Date()) / 1000)),
  }));
}
```

## Implications

- The "trust but verify" model lets the agent act immediately for better responsiveness, while giving users a configurable safety net (default 5 minutes, 10 minutes for drafts)
- DB-backed buffering survives restarts -- unlike in-memory action logs, buffered actions persist through deployments and crashes
- Domain-specific undo handlers keep reversal logic close to the service it operates on (Gmail, tasks, documents), making it testable in isolation
- The reversible action registry is a closed set -- only explicitly declared action types can be buffered, preventing accidental buffering of irreversible operations
- TTL expiration is a clean state transition: `buffered` -> `finalized` happens automatically, no user action required for the happy path
- The `undoPayload` carries all data needed for reversal at buffer time -- the undo handler doesn't need to re-query state, which avoids race conditions if the underlying data changes
- Maintenance cleanup (7-day default) prevents the action_buffer table from growing unboundedly
- Action types use a `service.operation` naming convention (e.g., `email.archive`) that makes dispatch routing trivial via `actionType.split('.')`

## Code Example

```javascript
const buffer = require('./lib/agent/action-buffer');

// Agent archives an email autonomously
const bufferId = await buffer.bufferAction({
  actionType: 'email.archive',
  description: 'Archived newsletter from TechDaily',
  undoPayload: { messageId: 'abc123' },
  ttlSeconds: 300,
});

// User sees notification: "Archived newsletter from TechDaily [Undo]"

// Check what's undoable
const undoable = await buffer.getBufferedActions();
// → [{ id: 5, actionType: 'email.archive', description: 'Archived newsletter...',
//      remainingSeconds: 287 }]

// User clicks Undo within 5 minutes
const result = await buffer.undoAction(bufferId);
// → { success: true, message: 'Undone: Archived newsletter from TechDaily' }

// After TTL expires, unclaimed actions auto-finalize
await buffer.finalizeExpired();

// Weekly cleanup of old records
await buffer.cleanup(7);
```

## Related Patterns

- [Undo and Revert System](./undo-and-revert-system.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
