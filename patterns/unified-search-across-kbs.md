# Unified Search Across Knowledge Bases

> Fan-out search across multiple knowledge sources with graceful partial failure and token-budgeted context injection.

## Problem

Knowledge is fragmented. Each project has its own knowledge base, the orchestrator has its own memory store, and relevant context might live in any combination of these sources. Finding "that thing about ring buffers" means manually checking multiple systems. Worse, when the orchestrator dispatches work to agents, those agents lack cross-project context that might be relevant to their task.

## Context

- Multiple projects registered with a central orchestrator, each potentially exposing searchable knowledge
- The orchestrator maintains its own memory store with semantic search (e.g., PostgreSQL with pgvector)
- Cross-cutting queries are common ("everything about authentication across all projects")
- Search results must be injected into agent dispatch context without exceeding token budgets
- Individual knowledge sources may be slow or temporarily unavailable — search must not block on failures

## Solution

### Parallel Multi-Source Fan-Out

Queries fan out to all registered knowledge sources simultaneously using `Promise.allSettled()`. No single slow or failing source blocks results from the others:

```javascript
async function unifiedSearch(query) {
  const sources = [
    searchOrchestratorMemory(query),
    ...registeredSources.map(src => searchSource(src, query))
  ];

  const results = await Promise.allSettled(sources);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .map(r => ({ ...r, _source: r._source }));  // Tag with origin
}
```

Failed sources are silently dropped — partial results are better than no results. The `allSettled` pattern means a 30-second timeout on one source does not delay results from the four that responded in 200ms.

### Orchestrator Memory as Primary Backend

The orchestrator's own memory store serves as the primary search backend, typically backed by PostgreSQL with pgvector for semantic search:

- **Embedding-based retrieval:** Queries are embedded and matched against stored memory vectors using cosine similarity
- **Conflict detection:** Before storing new memories, check for high similarity (>0.85) with significant text divergence (>30%) to flag contradictions
- **Supersession:** Old memories can be marked as superseded and filtered from query results
- **Ranking:** Combines embedding similarity, domain relevance, access frequency, and recency
- **Fallback:** Keyword search when the embedding service is unavailable

### Source Tagging and Ranking

Every result is tagged with its source, allowing downstream consumers to understand provenance:

```javascript
function rankResults(results) {
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxResults);
}
```

Results from different sources use different relevance scoring (semantic similarity vs. keyword match vs. exact match), so cross-source ranking is best-effort. Source tags let the consumer weight results by trust level if needed.

### Token-Budgeted Context Injection

Search results are automatically injected into agent dispatch context, constrained by a token budget:

```javascript
async function getSearchContext(message, tokenBudget = 600) {
  const results = await unifiedSearch(message);
  const ranked = rankResults(results);

  let context = '';
  for (const result of ranked) {
    const entry = formatResult(result);
    if (estimateTokens(context + entry) > tokenBudget) break;
    context += entry;
  }
  return context;
}
```

This runs on relevant dispatches, ensuring agents have cross-project awareness without explicitly requesting it and without blowing up context windows.

## Implications

- Latency is bounded by the slowest responding source, but `allSettled` prevents failures from blocking — the trade-off is that slow sources may return results after the budget is already filled by faster sources
- Different knowledge backends have different query capabilities (full-text vs. semantic vs. exact match) — cross-source ranking is inherently approximate
- Token budget for context injection (default ~600 tokens) means only top-ranked results are included; important but lower-ranked results may be dropped
- No deduplication across sources — the same fact stored in two knowledge bases appears twice in results
- The embedding service is a dependency for semantic search; keyword fallback preserves availability but reduces quality
- Adding new knowledge sources requires registering them with the search coordinator but does not require changes to the fan-out or ranking logic

## Code Example

```javascript
// Unified search with context injection into agent dispatch
const searchContext = await getSearchContext(
  'authentication flow for the billing service',
  600  // token budget
);

// Inject into agent prompt
const enrichedPrompt = `
${userMessage}

--- Relevant context from knowledge bases ---
${searchContext}
`;

// Dispatch agent with cross-project awareness
await dispatch({ prompt: enrichedPrompt, model: 'sonnet' });
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
