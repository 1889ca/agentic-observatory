# Undo and Revert System

> Tool-level undo declarations with action log tracking, enabling reversible agent operations through before/after state capture and time-bounded revert windows.

## Problem

Agents execute actions with real consequences — updating records, modifying files, changing configurations. Users need the ability to reverse mistakes, but agent systems typically treat every action as final. Without structured undo support, reverting a bad action requires manual intervention: finding what changed, figuring out the previous state, and manually restoring it. This is especially painful when the agent made a chain of related changes.

## Context

- An agent system where tools perform stateful operations (database writes, file modifications, API calls)
- Users interact conversationally and may say "undo that" or "revert the last change"
- Some operations are inherently irreversible (sending a message, triggering a deploy)
- The system needs to distinguish between what *can* be undone and what *cannot*
- Undo should be time-bounded — reverting something from two weeks ago is a different problem than reverting the last action

## Solution

### Tool-Level Undo Declarations

Each tool declares whether it supports undo, and if so, provides an undo handler alongside its execute handler. This keeps undo logic co-located with the action logic:

```javascript
// lib/undo/tool-with-undo.js
function defineTool({ name, execute, undo = null, undoable = false }) {
  return {
    name,
    execute,
    undo,
    undoable: undoable && typeof undo === 'function',
  };
}

const updateTask = defineTool({
  name: 'update_task',
  undoable: true,

  execute: async (args) => {
    const before = await db.getTask(args.id);
    const after = await db.updateTask(args.id, args.changes);
    return { result: after, beforeState: before, afterState: after };
  },

  undo: async (args, beforeState) => {
    await db.updateTask(args.id, beforeState);
    return { restored: beforeState };
  },
});
```

### Action Log

Every tool execution is recorded in an action log with enough context to support undo. The log captures before/after state, the arguments used, and whether the action is undoable:

```javascript
// lib/undo/action-log.js
const actionLog = [];

function recordAction({ toolName, args, result, beforeState, afterState, undoable }) {
  const entry = {
    id: crypto.randomUUID(),
    toolName,
    args,
    result,
    beforeState,
    afterState,
    undoable,
    timestamp: Date.now(),
    undone: false,
  };

  actionLog.push(entry);
  return entry;
}

function getUndoableActions(windowMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  return actionLog
    .filter(a => a.undoable && !a.undone && a.timestamp > cutoff)
    .reverse(); // Most recent first
}
```

### Undo Execution

When a user requests undo, the system finds the most recent undoable action (or a specific one by reference), runs the undo handler, and marks the action as undone. The undo itself is logged as a new action:

```javascript
// lib/undo/undo-executor.js
async function undoLastAction(toolRegistry) {
  const candidates = getUndoableActions();

  if (candidates.length === 0) {
    return { success: false, reason: 'No undoable actions in the current window' };
  }

  const action = candidates[0];
  const tool = toolRegistry.get(action.toolName);

  if (!tool?.undo) {
    return { success: false, reason: `Tool ${action.toolName} has no undo handler` };
  }

  const undoResult = await tool.undo(action.args, action.beforeState);

  // Mark original action as undone
  action.undone = true;

  // Log the undo itself as an action
  recordAction({
    toolName: `undo:${action.toolName}`,
    args: { originalActionId: action.id },
    result: undoResult,
    beforeState: action.afterState,
    afterState: action.beforeState,
    undoable: false, // Undo of undo is not supported — use redo semantics if needed
  });

  return { success: true, restored: undoResult };
}
```

### Non-Undoable Tool Marking

Some tools are inherently irreversible. These are marked explicitly so the system can communicate this to users upfront rather than failing silently:

```javascript
const sendMessage = defineTool({
  name: 'send_message',
  undoable: false, // Cannot unsend

  execute: async (args) => {
    const result = await messenger.send(args.channel, args.content);
    // Still logged for audit trail, but undoable=false
    return { result, beforeState: null, afterState: null };
  },
});

const deployService = defineTool({
  name: 'deploy',
  undoable: false, // Rollback is a different operation, not undo

  execute: async (args) => {
    const result = await deployer.deploy(args.service, args.version);
    return { result, beforeState: null, afterState: null };
  },
});
```

### Time-Bounded Window

Undo availability expires after a configurable window. This prevents stale state conflicts — undoing an action from hours ago when the data has been modified multiple times since would cause corruption:

```javascript
// lib/undo/config.js
const UNDO_WINDOW_MS = parseInt(process.env.UNDO_WINDOW_MS) || 60 * 60 * 1000; // 1 hour default

function isWithinUndoWindow(action) {
  return Date.now() - action.timestamp < UNDO_WINDOW_MS;
}
```

## Implications

- Before/after state capture adds overhead to every tool execution — tools must return `beforeState` explicitly, which means an extra read before every write
- The action log grows linearly with tool executions; periodic cleanup of entries outside the undo window is necessary
- Undo handlers are the tool author's responsibility — if the undo logic is wrong, it can corrupt state just as easily as the original action
- Time-bounding prevents stale-state conflicts but means users lose undo capability after the window expires
- Non-undoable marking is honest UX — better to tell users upfront than to promise reversibility and fail
- The action log doubles as an audit trail, useful for debugging agent behavior independent of undo
- Undo-of-undo is intentionally not supported to avoid infinite chains; a separate redo mechanism would be needed for that

## Code Example

```javascript
// Wrapping tool execution with action logging and undo support
async function executeTool(toolRegistry, toolName, args) {
  const tool = toolRegistry.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  const { result, beforeState, afterState } = await tool.execute(args);

  const entry = recordAction({
    toolName,
    args,
    result,
    beforeState,
    afterState,
    undoable: tool.undoable,
  });

  return { ...result, actionId: entry.id, undoable: tool.undoable };
}

// User says "undo that"
async function handleUndoRequest(toolRegistry) {
  const result = await undoLastAction(toolRegistry);

  if (result.success) {
    return `Reverted the last action. Restored previous state.`;
  } else {
    return `Cannot undo: ${result.reason}`;
  }
}
```

## Related Patterns

- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Agent Recovery and Escalation](./agent-recovery-and-escalation.md)
- [Planning and Verification Layer](./planning-and-verification-layer.md)
