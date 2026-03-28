# Undo and Revert System

> DB-backed undo stack with entity-type reversers, enabling users to reverse agent mutations through tenant-scoped before/after state tracking and type-specific reversal logic.

## Problem

Agents execute actions with real consequences -- creating tasks, updating notes, deleting reminders, completing events. Users need the ability to reverse mistakes, but agent systems typically treat every action as final. Without structured undo support, reverting a bad action requires manual intervention: finding what changed, figuring out the previous state, and manually restoring it. This is especially painful when the agent misinterprets intent and creates the wrong task or completes something that wasn't finished.

## Context

- An agent system where tools perform stateful operations across multiple entity types (todos, notes, reminders, events)
- Users interact conversationally and may say "undo that" or "revert the last change"
- Operations span CRUD actions plus domain-specific actions like "complete" and "cancel"
- The undo stack must survive process restarts -- in-memory logs are insufficient for production
- Stack depth must be bounded to prevent unbounded database growth
- Different entity types require different reversal logic (deleting a todo vs. restoring a note's content)

## Solution

### DB-Backed Undo Stack

The undo stack is a PostgreSQL table (`undo_stack`) scoped to tenants, with a configurable depth limit. Every mutation records the action type, entity type, entity ID, and before/after state snapshots:

```javascript
// lib/undo/stack.js
const STACK_LIMIT = 50;

async function push(action) {
  const tenantId = 1;

  // Enforce stack limit by removing oldest entries
  await enforceLimit(tenantId);

  const id = await insert('undo_stack', {
    tenant_id: tenantId,
    user_id: action.userId || null,
    action_type: action.actionType,    // 'create', 'update', 'delete', 'complete'
    entity_type: action.entityType,    // 'todo', 'note', 'reminder', 'event'
    entity_id: String(action.entityId),
    before_state: action.beforeState ? JSON.stringify(action.beforeState) : null,
    after_state: action.afterState ? JSON.stringify(action.afterState) : null,
    tool_name: action.toolName || null,
  });

  return id;
}

async function pop() {
  const action = await select('undo_stack')
    .where('tenant_id = ?', tenantId)
    .orderBy('created_at DESC')
    .limit(1)
    .one();

  if (!action) return null;

  await del('undo_stack', 'id = ?', action.id);
  return parseAction(action);
}
```

The stack enforces its limit with a single SQL statement that deletes the oldest entries beyond the threshold:

```javascript
async function enforceLimit(tenantId) {
  await raw(
    `DELETE FROM undo_stack
     WHERE id IN (
       SELECT id FROM undo_stack
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       OFFSET $2
     )`,
    [tenantId, STACK_LIMIT - 1]
  );
}
```

### Entity-Type Reversers

Rather than co-locating undo logic with each tool, reversal logic is organized by entity type in a `REVERSERS` map. Each entity type defines handlers for each action type, creating a clear matrix of what can be undone and how:

```javascript
// lib/undo/reverser.js
const REVERSERS = {
  todo: {
    // Undo create -> delete the created task
    create: async (action) => {
      await tasksV2.remove(action.entityId);
      return { reversed: 'create', message: `Deleted task "${action.afterState?.title}"` };
    },

    // Undo update -> restore previous state
    update: async (action) => {
      const { beforeState } = action;
      if (!beforeState) throw new Error('No before state to restore');

      await entityService.update('task', action.entityId, {
        title: beforeState.title,
        description: beforeState.description,
        priority: beforeState.priority,
        dueAt: beforeState.due_at || beforeState.due_date,
      });

      return { reversed: 'update', message: `Restored task "${beforeState.title}"` };
    },

    // Undo delete -> recreate from before state
    delete: async (action) => {
      const { beforeState } = action;
      if (!beforeState) throw new Error('No before state to restore');

      const newTask = await entityService.create('task', {
        title: beforeState.title,
        priority: beforeState.priority || 'normal',
      }, { source: 'undo' });

      return { reversed: 'delete', message: `Restored task "${beforeState.title}"`, newId: newTask.id };
    },

    // Undo complete -> reopen
    complete: async (action) => {
      await entityService.update('task', action.entityId, {
        status: action.beforeState?.status || 'pending',
      });
      return { reversed: 'complete', message: `Reopened task "${action.beforeState?.title}"` };
    },
  },

  note: {
    create: async (action) => {
      await documents.remove(action.entityId);
      return { reversed: 'create', message: `Deleted note "${action.afterState?.data?.title}"` };
    },

    update: async (action) => {
      await documents.update(action.entityId, action.beforeState.data, { replace: true });
      return { reversed: 'update', message: `Restored note "${action.beforeState.data?.title}"` };
    },

    delete: async (action) => {
      const newDoc = await documents.create('note', action.beforeState.data, {
        parentId: action.beforeState.parent_id,
      });
      return { reversed: 'delete', message: `Restored note`, newId: newDoc.id };
    },
  },

  reminder: { /* cancel, create reversal handlers */ },
  event:    { /* create, update, delete reversal handlers */ },
};
```

### Undo Execution with Failure Recovery

The undo operation pops the most recent action, runs the appropriate reverser, and re-pushes the action if reversal fails (so the user can retry):

```javascript
// lib/undo/index.js
async function undo() {
  const action = await stack.pop();

  if (!action) {
    return { success: false, message: 'Nothing to undo' };
  }

  try {
    const result = await reverse(action);
    return {
      success: true,
      undone: describeAction(action),
      ...result,
    };
  } catch (err) {
    // Push the action back since we couldn't undo it
    await stack.push({
      actionType: action.actionType,
      entityType: action.entityType,
      entityId: action.entityId,
      beforeState: action.beforeState,
      afterState: action.afterState,
      toolName: action.toolName,
    });

    return {
      success: false,
      message: `Failed to undo: ${err.message}`,
      action: describeAction(action),
    };
  }
}
```

### Human-Readable Descriptions

Every action gets a description for user-facing messages:

```javascript
function describeAction(action) {
  const entityName = action.afterState?.title || action.beforeState?.title || action.entityId;
  const descriptions = {
    create: `Created ${action.entityType} "${entityName}"`,
    update: `Updated ${action.entityType} "${entityName}"`,
    delete: `Deleted ${action.entityType} "${entityName}"`,
    complete: `Completed ${action.entityType} "${entityName}"`,
    cancel: `Cancelled ${action.entityType} "${entityName}"`,
  };
  return descriptions[action.actionType] || `${action.actionType} ${action.entityType}`;
}
```

## Implications

- DB-backed stack survives process restarts -- unlike in-memory logs, nothing is lost if the server crashes between action and undo
- Entity-type reversers create a clear, extensible matrix: adding undo for a new entity type means adding one object to `REVERSERS`, not modifying every tool
- The 50-entry stack limit prevents unbounded growth while covering typical undo depth; the oldest entries are pruned automatically via SQL
- Before/after state capture adds overhead to every tool execution -- tools must snapshot state before writes, meaning an extra read before every mutation
- Failure recovery (re-pushing the action on undo failure) prevents the stack from losing entries when external services are temporarily down
- Undo of delete operations creates new entities with new IDs (`newId`) -- the original ID is gone, which may break references from other entities
- The `parseAction` function handles both JSON string and object formats for before/after state, tolerating schema evolution in the stack table
- Tenant scoping means multi-tenant deployments get isolated undo stacks without cross-contamination

## Code Example

```javascript
const undo = require('./lib/undo');

// Record an action when a tool executes
await undo.push({
  actionType: 'create',
  entityType: 'todo',
  entityId: 123,
  beforeState: null,
  afterState: { title: 'Buy groceries', priority: 2 },
  toolName: 'add_todo',
});

// User says "undo that"
const result = await undo.undo();
// → { success: true, undone: 'Created todo "Buy groceries"', reversed: 'create',
//    message: 'Deleted task "Buy groceries"' }

// Peek at what would be undone next
const desc = await undo.peekDescription();
// → 'Updated note "Meeting notes"'

// List recent undo stack
const recent = await undo.list(5);
// → [{ actionType: 'update', entityType: 'note', toolName: 'update_note', ... }]

// Check stack depth
const depth = await undo.count();
// → 12
```

## Related Patterns

- [Action Coordination and Conflict Prevention](./action-coordination-and-conflict-prevention.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
