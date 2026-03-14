# Context Assembly Pipeline

> Budget-aware assembly of multi-source context for each AI dispatch, tuned by dispatch type.

## Problem

An orchestrator receives messages from many sources — users, scheduled tasks, internal reflections, webhook events. Each needs relevant context, but the amount and type of context differs radically. A user question needs focused search results; a periodic reflection needs broad memory access; a quick triage needs minimal context to stay fast. Cramming maximum context into every dispatch wastes tokens, slows responses, and drowns signal in noise.

## Context

- An orchestrator dispatching to multiple AI models (triage vs. deliberative)
- Multiple context sources: semantic memory, conversation history, project KBs, pinned items
- Token budgets that vary by model and task type
- Need for both speed (triage) and depth (reflection, postmortem)
- Projects registering their own searchable knowledge bases

## Solution

### Dispatch-Type Budgets

Define token and result budgets per dispatch type:

```javascript
const BUDGETS = {
  user:          { results: 8,  tokens: 600 },
  reflection:    { results: 30, tokens: 3000 },
  postmortem:    { results: 30, tokens: 3000 },
  consolidation: { results: 20, tokens: 2000 },
  default:       { results: 8,  tokens: 600 },
};
```

User messages get lean context for fast response. Reflective processes get 5x the budget for thorough self-examination.

### Multi-Source Assembly

Context is assembled from multiple sources in parallel, then merged under the token budget:

1. **Semantic search** — Query embeddings across all registered project KBs and personal memory
2. **Pinned memories** — Always included, prioritized above search results
3. **Conversation history** — Recent exchanges for continuity (fallback when semantic search unavailable)
4. **Time context** — Current date, recent activity summary
5. **Orientation briefing** — On cold starts, injected from last consolidation

```javascript
async function assembleContext(message, dispatchType) {
  const budget = BUDGETS[dispatchType] || BUDGETS.default;

  const [searchResults, pinned, history] = await Promise.all([
    semanticSearch(message, budget.results),
    getPinnedMemories(),
    getRecentHistory(10)
  ]);

  // Pinned items get priority, then search results fill remaining budget
  let context = formatPinned(pinned);
  const remaining = budget.tokens - estimateTokens(context);
  context += trimToTokens(formatResults(searchResults), remaining);

  return context;
}
```

### Budget-Aware Trimming

Results are scored and ranked, then trimmed to fit the token budget. Trimming preserves high-scoring results and truncates or drops low-scoring ones. This ensures the most relevant context always fits, regardless of how many sources return results.

### Two-Tier Dispatch

The assembled context feeds a two-tier model system with dynamic model switching:
- **Fast triage layer**: Evaluates all incoming items with minimal context. Marks complex items with `ESCALATE:` prefix
- **Deliberative layer**: Receives escalated items with full context budget. Maintains persistent session for continuity

Models are selected dynamically (Claude, Gemini, etc.) based on task characteristics and cost/latency requirements, rather than being fixed to specific model families. This separation means routine items (status updates, simple queries) get fast answers without burning expensive context assembly on them.

## Implications

- Budget tuning is empirical — too tight and the model lacks context, too loose and you waste tokens
- Parallel search across multiple KBs adds latency; consider caching for frequently-accessed projects
- Pinned memories always consuming budget means they should be kept minimal
- The triage layer can incorrectly filter important items if the fast model misjudges complexity
- Conversation history as fallback means degraded quality when semantic search is down
- Token estimation is approximate — actual token counts may vary by model

## Code Example

```javascript
// Complete dispatch cycle with context assembly
async function dispatch(message, source) {
  const dispatchType = classifySource(source);
  const context = await assembleContext(message, dispatchType);

  // Triage layer — fast evaluation
  if (dispatchType !== 'user') {
    const triage = await triageModel.send(message, { context: minimal(context) });
    if (!triage.includes('ESCALATE:')) {
      return triage; // handled at triage level
    }
  }

  // Deliberative layer — full context
  return await deliberativeModel.send(message, {
    context,
    sessionId: currentSessionId // persistent session for continuity
  });
}
```

## Related Patterns

- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
