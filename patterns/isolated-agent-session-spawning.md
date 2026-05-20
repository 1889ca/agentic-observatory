# Isolated Agent Session Spawning

> Spawn named sub-agent sessions with per-session allowed/denied tool lists, parent-child lineage, and inter-session messaging — so the parent can delegate constrained work without granting the child its full tool surface.

## Problem

When the main agent delegates a sub-task ("research X", "draft this email", "summarize this thread"), running the sub-task in the same execution context gives it full access to every tool the parent can call. That's both unsafe (the research task can now send messages, schedule jobs, modify entities) and confusing for audit (every action is logged under one principal). The alternative — manually plumbing a restricted tool subset on every call site — is too tedious to stay consistent.

## Context

- The main agent occasionally needs to delegate work to a focused sub-agent
- Sub-agents should run with a narrow tool surface tailored to their job (research = read + search; drafting = write + summarize)
- Audit needs to attribute actions to the specific sub-session that took them, not the parent
- Sub-agents may need to send results back to the parent, or coordinate with sibling sessions
- Tool filtering must work transparently — the executing code shouldn't need to know it's in a restricted session

## Solution

A session is a database row with a unique name, a parent session id (nullable), an `allowedTools` whitelist (or `deniedTools` blacklist), an opaque `context` object, and a status. Spawning a session creates the row and registers it in an in-memory cache; running code inside a session uses an async-local-storage context that any tool dispatcher can consult to filter the available tools.

### Spawning a Session

```javascript
const session = await agentSessions.spawn({
  name: 'research-tariffs',
  parentSessionId: currentSession?.id || null,
  allowedTools: ['search', 'remember', 'web_fetch'],   // whitelist
  // deniedTools: ['send_message', 'create_task'],     // alternative blacklist
  initialContext: { topic: 'tariff impact on Q3', deadline: '2026-05-22' },
})
// → { id, name, status: 'active', allowedTools, deniedTools }
```

The session name is the human handle (`research-tariffs`); the id is the stable reference. Both are indexed in the cache for fast lookup.

### Async-Local-Storage Context

The interesting trick is making tool filtering automatic. Code wrapped in `runWithSession(sessionId, fn)` runs inside an `AsyncLocalStorage` context — any code beneath it, no matter how deeply nested, can ask "what session am I in?" without parameter threading:

```javascript
// lib/agent-sessions/context.js
const { AsyncLocalStorage } = require('node:async_hooks')
const sessionStorage = new AsyncLocalStorage()

function runWithSession(sessionId, fn) {
  return sessionStorage.run({ sessionId }, fn)
}

function getCurrentSessionId() {
  return sessionStorage.getStore()?.sessionId
}

function isToolAllowedInContext(toolName) {
  const sessionId = getCurrentSessionId()
  if (!sessionId) return true                  // no session = full surface
  return manager.isToolAllowed(sessionId, toolName)
}

function filterToolsForContext(toolList) {
  const sessionId = getCurrentSessionId()
  if (!sessionId) return toolList
  return toolList.filter(t => manager.isToolAllowed(sessionId, t.name))
}
```

Tool dispatchers call `isToolAllowedInContext(toolName)` before executing — a tool that's not in the session's allowed set fails the check and is rejected.

### Inter-Session Messaging

Sessions can send messages to each other (`send`), reply (`reply`), broadcast (`broadcast`), and read history (`getHistory`). The parent dispatches a task to a child via `send`, the child replies with a result, and the parent reads it back:

```javascript
// Parent kicks off the child
await agentSessions.send({
  to: 'research-tariffs',
  from: 'main',
  message: 'Find recent rulings on steel tariffs',
  awaitReply: true,
  timeout: 60_000,
})
// → resolves with the child's reply
```

`awaitReply` lets the parent block on the child's response; without it, the message is fire-and-forget and the parent reads back later via `getHistory(sessionName)`.

### Parent-Child Lineage

The `parentSessionId` column records who spawned whom. This makes audit trees navigable ("show me everything the research-tariffs sub-session did under the main session's morning routine call") and lets termination cascade — terminating a parent can terminate its children if the caller wants that behavior.

### Termination and Status

```javascript
await agentSessions.terminate('research-tariffs')
// → sets status='terminated', clears cache entries
```

Active sessions are cached by both id and name; termination removes both. The session row stays in the database with its terminated status for audit, so the history of past sessions is queryable.

## Implications

- **Tool filtering is transparent to executors** — `runWithSession` + AsyncLocalStorage means deeply nested code is automatically restricted; no need to thread a `session` argument through every function call
- **Whitelist vs. blacklist tradeoff** — `allowedTools` is safer (default-deny) and works well for narrow sub-tasks; `deniedTools` is convenient when you want "everything except these two" and is appropriate for trusted helper sessions
- **Names are user-facing handles, ids are stable** — operators reference sessions by name (`research-tariffs`); internal code references them by id. Duplicate active names are rejected at spawn
- **Parent-child lineage enables audit trees** — every action a child takes can be traced back to the parent's triggering call, which is essential for "why did the agent do X?" debugging
- **In-memory cache means single-process scope** — for multi-instance deployments, the cache is per-process; cross-instance session sharing would need an external store or message bus
- **`awaitReply` is a synchronous bridge over async sessions** — convenient for delegation but turns the parent into a blocking caller; use sparingly in latency-sensitive paths
- **Sessions outlive a single call** — a session can stay active across many messages, which is what makes it different from "spawn a sandbox, run one thing, dispose"

## Code Example

```javascript
const agentSessions = require('./lib/agent-sessions')

// Spawn a tightly-scoped research session
const research = await agentSessions.spawn({
  name: 'pricing-research',
  parentSessionId: agentSessions.getCurrentSessionId(),
  allowedTools: ['search', 'web_fetch', 'remember'],
  initialContext: { competitor: 'AcmeCorp', focus: 'enterprise tier' },
})

// Delegate, await reply
const result = await agentSessions.send({
  to: 'pricing-research',
  from: 'main',
  message: 'Find published pricing for AcmeCorp enterprise tier',
  awaitReply: true,
})

// Inside the research session, any tool call goes through the filter
await agentSessions.runWithSession(research.id, async () => {
  // search() works — in allowedTools
  // send_message() fails — not in allowedTools
  const findings = await tools.search({ query: 'AcmeCorp enterprise pricing' })
  await tools.remember({ key: 'acme.enterprise', value: findings })
})

await agentSessions.terminate('pricing-research')
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Request-Scoped Context](./request-scoped-context.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Tools Factory and Declarative Tool Definition](./tools-factory-and-declarative-tool-definition.md)
