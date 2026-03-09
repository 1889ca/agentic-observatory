# Unified Search Across Knowledge Bases

> Architecture for searching multiple project knowledge bases and memory simultaneously.

## Problem

Knowledge is fragmented. Each project has its own KB (via MCP tools, HTTP endpoints, or shell scripts), Claude Code has auto-memory directories per project, and the orchestrator has its own embedding-backed memory store. Finding "that thing about ring buffers" means manually checking three or four different systems. Worse, when the orchestrator dispatches work to satellites, those satellites lack cross-project context that might be relevant.

## Context

- Multiple projects registered with the orchestrator, each with a KB
- CC auto-memory directories per project (`.claude/` files)
- Orchestrator's internal memory store with semantic search
- Need for cross-cutting queries ("everything about authentication across all projects")
- Results must be injected into satellite dispatches for context-aware work

## Solution

### Parallel Multi-Source Fan-Out

Queries fan out to all registered sources simultaneously using `Promise.allSettled()` — no single slow source blocks the results:

```javascript
async function unifiedSearch(query) {
  const sources = [
    searchLocalMemory(query),           // Orchestrator's own store
    ...projects.map(p => searchProjectKB(p, query))  // All project KBs
  ];

  const results = await Promise.allSettled(sources);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .map(r => ({ ...r, _source: r._source }));  // Tag with origin
}
```

Failed sources are silently dropped — partial results are better than no results.

### Three KB Backend Types

Each project declares its search interface in `.riley/capabilities.yaml`:

**MCP Tool:**
```yaml
search:
  type: mcp
  tool: kb_search
  query_param: query
```
The orchestrator maintains MCP session IDs per URL, auto-initializes on 400/404, and parses results from `result.content[].text` (handling nested `{ results: [...] }` wrappers).

**HTTP Endpoint:**
```yaml
search:
  type: http
  url: "http://localhost:3001/api/search"
```
Expects `{ results: [...] }` or plain array response.

**Shell Script:**
```yaml
search:
  type: script
  command: "./search.sh"
```
Spawns shell process, passes query as argument, parses JSON stdout. 15-second timeout prevents hanging.

### Automatic Context Injection

Search results are automatically injected into every satellite dispatch:

```javascript
async function getUnifiedContext(message, tokenBudget = 600) {
  const results = await unifiedSearch(message);
  // Format results within token budget
  // Inject as additional context in satellite prompt
}
```

This runs on every user message, ensuring satellites always have cross-project awareness without explicitly requesting it.

### Orchestrator Memory: Embedding-Based Search

The orchestrator's own memory uses Gemini `embedding-001` for semantic search:

- **Conflict detection:** Before storing, checks if similarity >0.85 with text divergence >30% (flags contradictory memories)
- **Supersession:** Old memories can be marked as superseded, filtered from queries
- **Domain-aware thresholds:** Different similarity thresholds for different content types
- **Ranking:** Combines embedding similarity + domain match + access frequency + recency
- **Fallback:** Keyword search when embeddings are unavailable

## Implications

- Latency bounded by the slowest responding source (mitigated by `allSettled` — don't wait for failures)
- Different KBs have different query capabilities (full-text vs. semantic vs. exact match) — no way to normalize ranking across heterogeneous sources
- Token budget for context injection (default 600) means only top results are included
- MCP session management adds complexity — sessions can expire, requiring re-initialization
- Shell script backends are a security surface — arbitrary command execution
- No deduplication across sources — the same fact stored in two KBs appears twice

## Code Example

```javascript
// MCP search with session management
async function searchMCP(project, query) {
  let sessionId = mcpSessions.get(project.mcp.url);

  if (!sessionId) {
    sessionId = await initMCPSession(project.mcp.url, project.mcp.headers);
    mcpSessions.set(project.mcp.url, sessionId);
  }

  const result = await callMCPTool(sessionId, project.search.tool, {
    [project.search.query_param]: query
  });

  // Handle nested result formats
  const parsed = JSON.parse(result.content[0].text);
  const items = parsed.results || parsed;
  return items.map(r => ({ ...r, _source: project.name }));
}
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
