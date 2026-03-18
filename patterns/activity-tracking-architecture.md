# Activity Tracking Architecture

> Session-based activity tracking using hierarchical agent sessions with inter-session messaging, tool permissions, and structured message history for real-time and historical visibility into agent execution.

## Problem

With multiple agent workers running concurrently across different task types, there's no unified view of what's happening. Without structured session tracking, it's impossible to answer "what are my agents doing right now?", "what tools is this agent allowed to use?", or "what messages were exchanged between agents during this task?" Activity data needs to support both real-time monitoring and historical queries, with clear boundaries between concurrent execution contexts.

## Context

- An orchestrator managing multiple concurrent agent workers
- Need for isolated execution contexts that prevent cross-task contamination
- Parent-child relationships between sessions (an orchestrator session spawning worker sessions)
- Per-session tool permissions — some agents should only access specific tools
- Inter-session communication where agents can message each other
- Real-time visibility into active sessions and historical queries for post-mortems
- Sessions that can be paused, resumed, or terminated

## Solution

### Database Schema: agent_sessions and agent_session_messages

Two tables provide the tracking backbone. `agent_sessions` tracks execution contexts with their permissions and hierarchy. `agent_session_messages` stores all communication within and between sessions:

```sql
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  name VARCHAR(100) NOT NULL,
  parent_session_id UUID REFERENCES agent_sessions(id),  -- hierarchical
  status VARCHAR(20) DEFAULT 'active',  -- active, terminated, paused
  allowed_tools JSONB,   -- whitelist: ["tool_a", "tool_b"]
  denied_tools JSONB,    -- blacklist: ["dangerous_tool"]
  context JSONB,         -- arbitrary session metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE agent_session_messages (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,
  from_session_id UUID REFERENCES agent_sessions(id),  -- nullable for external input
  role VARCHAR(20) NOT NULL,  -- user, assistant, system
  content TEXT NOT NULL,
  tool_calls JSONB,    -- structured record of tool invocations
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Session Lifecycle: spawn, execute, terminate

Sessions are created with explicit tool permissions and optional parent linkage:

```javascript
// lib/agent-sessions/index.js

async function spawn(name, allowedTools, deniedTools, context) {
  const session = await store.create({
    name,
    allowed_tools: allowedTools || [],
    denied_tools: deniedTools || [],
    context: context || {},
    status: 'active',
  });
  return session;
}

async function terminate(sessionName) {
  await store.updateByName(sessionName, {
    status: 'terminated',
    updated_at: new Date(),
  });
}
```

### Execution Within Session Context

`runWithSession` scopes a function's execution to a specific session, making tool permission checks automatic:

```javascript
// lib/agent-sessions/index.js

async function runWithSession(sessionId, fn) {
  const session = await store.getById(sessionId);
  if (!session || session.status !== 'active') {
    throw new Error(`Session ${sessionId} is not active`);
  }

  // Execute within session context — tool calls are gated
  return fn({
    sessionId,
    isToolAllowed: (toolName) => isToolAllowedInContext(session, toolName),
    send: (to, message, awaitReply) => send(to, message, awaitReply),
    reply: (threadId, message) => reply(threadId, message),
  });
}

function isToolAllowedInContext(session, toolName) {
  if (session.denied_tools?.includes(toolName)) return false;
  if (session.allowed_tools?.length > 0) {
    return session.allowed_tools.includes(toolName);
  }
  return true;  // no whitelist = all allowed (minus blacklist)
}
```

### Inter-Session Messaging

Agents communicate through structured messages stored in `agent_session_messages`. The `from_session_id` field tracks which session originated each message, enabling conversation reconstruction:

```javascript
// lib/agent-sessions/index.js

async function send(toSessionName, message, awaitReply = false) {
  const target = await store.getByName(toSessionName);
  if (!target) throw new Error(`Session '${toSessionName}' not found`);

  const msg = await store.insertMessage({
    session_id: target.id,
    from_session_id: currentSessionId(),
    role: 'user',
    content: message,
  });

  if (awaitReply) {
    return pollForReply(target.id, msg.id);
  }

  return msg;
}

async function reply(threadId, message) {
  const original = await store.getMessageById(threadId);
  return store.insertMessage({
    session_id: original.from_session_id,  // reply goes back to sender
    from_session_id: currentSessionId(),
    role: 'assistant',
    content: message,
  });
}
```

### Message History and Querying

Session history supports pagination for both real-time tailing and historical review:

```javascript
// lib/agent-sessions/index.js

async function getHistory(sessionName, limit = 50, offset = 0) {
  const session = await store.getByName(sessionName);
  return store.getMessages(session.id, { limit, offset });
}
```

### Parent-Child Session Hierarchy

Sessions can spawn child sessions, creating a tree that mirrors task decomposition:

```javascript
// Orchestrator spawns a scoped worker session
const parentSession = await spawn('orchestrator-main', null, null, {
  role: 'orchestrator',
});

const workerSession = await spawn('worker-issue-42', ['git', 'file_read', 'file_write'], ['deploy'], {
  role: 'worker',
  parent_session_id: parentSession.id,
  task: 'Resolve issue #42',
});
```

This hierarchy enables queries like "show me all sessions spawned by the orchestrator" or "what tool calls did the child sessions make?"

## Implications

- Session-based tracking replaces file-based JSONL logs — all activity is queryable via SQL, no log parsing required
- The `allowed_tools` / `denied_tools` JSONB fields provide per-session sandboxing without a separate permissions system
- Parent-child relationships enable hierarchical queries (all activity under a given orchestrator run) and scoped cleanup (terminating a parent can cascade to children)
- Inter-session messaging creates a structured audit trail of agent-to-agent communication, unlike fire-and-forget event emission
- The `awaitReply` flag on `send` enables both synchronous request-response and asynchronous fire-and-forget patterns between sessions
- `tool_calls` JSONB on messages captures structured tool invocation data alongside natural language content, supporting both human review and programmatic analysis
- The UNIQUE constraint on `(tenant_id, name)` prevents duplicate session names within a tenant, avoiding confusion in multi-session environments
- Session status (active/terminated/paused) enables graceful lifecycle management — paused sessions can be resumed without losing their message history or permissions

## Code Example

```javascript
// Full session lifecycle: spawn → execute with tool gating → communicate → query → terminate

async function runIsolatedWorker(taskName, allowedTools, task) {
  // 1. Spawn isolated session with tool permissions
  const session = await spawn(taskName, allowedTools, ['deploy', 'db_migrate'], {
    task_type: task.type,
    document_id: task.documentId,
  });

  // 2. Execute within session context
  const result = await runWithSession(session.id, async (ctx) => {
    // Tool calls are gated by session permissions
    if (!ctx.isToolAllowed('git')) {
      throw new Error('git not permitted in this session');
    }

    // Inter-session messaging
    await ctx.send('orchestrator-main', `Starting work on ${taskName}`);

    const output = await executeTask(task, ctx);

    await ctx.send('orchestrator-main', `Completed ${taskName}: ${output.summary}`);
    return output;
  });

  // 3. Query session history for audit
  const history = await getHistory(taskName, 100);
  console.log(`Session had ${history.length} messages`);

  // 4. Terminate session
  await terminate(taskName);

  return result;
}
```

## Related Patterns

- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
