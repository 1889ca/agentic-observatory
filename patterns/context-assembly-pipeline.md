# Context Assembly Pipeline

> Single-pass parallel context assembly with token budgeting across multiple sources, optimized for latency through concurrent fetching.

## Problem

An orchestrator receives messages from many sources — users, scheduled tasks, internal reflections, webhook events. Each needs relevant context, but the amount and type of context differs radically. A user question needs focused search results; a periodic reflection needs broad memory access; a quick triage needs minimal context. Cramming maximum context into every dispatch wastes tokens, slows responses, and drowns signal in noise.

## Context

- An orchestrator dispatching to multiple AI models
- Multiple context sources: semantic memory, conversation history, project KBs, pinned items
- Token budgets that vary by model and task type
- Need for speed — context assembly is the primary latency contributor
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

### Parallel Multi-Source Fetching

All context sources are fetched concurrently using `Promise.all()`. This is the critical performance optimization — sequential fetching would multiply latency:

```javascript
// context/index.js
async function assembleContext(message, dispatchType) {
  const budget = createBudgetTracker(BUDGETS[dispatchType] || BUDGETS.default);

  // Phase 1: Fire all async fetches in parallel
  const asyncFetches = [
    semanticSearch(message, budget.results),
    getPinnedMemories(),
    getRecentHistory(10),
    getActiveEntities(),
    getProjectContext(),
    getTimezoneContext(),
    getSituationalContext(),
    getAntiPatterns(),
    getKnowledgeGapQuestions(),
    getVibeInsights(),
  ];

  const results = await Promise.all(asyncFetches);

  // Phase 2: Assemble under token budget with priority ordering
  const context = assembleParts(results, budget);
  return context;
}
```

### Budget-Aware Assembly

Results are added to the context in priority order. Each `addPart()` call checks remaining budget before including content:

```javascript
function assembleParts(results, budget) {
  const parts = [];

  // Pinned items get priority — always included
  budget.addPart(parts, formatPinned(results.pinned), 'pinned');

  // Anti-patterns — high priority for LLM behavior correction
  budget.addPart(parts, formatAntiPatterns(results.antiPatterns), 'anti-patterns');

  // Search results fill remaining budget
  const remaining = budget.remaining();
  budget.addPart(parts, trimToTokens(formatResults(results.search), remaining), 'search');

  // History as fallback continuity
  budget.addPart(parts, formatHistory(results.history), 'history');

  return parts.join('\n');
}
```

### Simple vs. Complex Classification

Messages are classified to determine whether full context assembly is needed:

```javascript
// context/classification.js
function isSimpleMessage(text) {
  // Short messages, greetings, acknowledgments skip expensive context assembly
  if (text.length < 20) return true;
  if (SIMPLE_PATTERNS.some(p => p.test(text))) return true;
  return false;
}

// In the pipeline:
const simple = isSimpleMessage(textContent);
const context = simple
  ? null  // Skip context assembly entirely
  : await assembleContext(message, dispatchType);
```

### Content Extraction

Multimodal messages (text, images, files) are normalized into a uniform content structure before context assembly:

```javascript
// context/extraction.js
function extractContent(message) {
  const parts = [];
  if (message.text) parts.push({ type: 'text', content: message.text });
  if (message.images) parts.push(...message.images.map(img => ({ type: 'image', content: img })));
  if (message.attachments) parts.push(...processAttachments(message.attachments));
  return parts;
}
```

## Implications

- Parallel fetching reduces latency from sum-of-all-sources to max-of-all-sources — typically 3-5x faster
- Budget tuning is empirical — too tight and the model lacks context, too loose and you waste tokens
- Simple message classification saves ~200-500ms by skipping context assembly entirely for trivial inputs
- Pinned memories always consuming budget means they should be kept minimal
- No separate triage layer — all messages go through the same single pipeline with budget-based assembly
- Token estimation is approximate — actual token counts may vary by model
- Anti-pattern injection into context means learned corrections are always fresh

## Code Example

```javascript
// Complete context assembly for a user message
async function prepareMessageWithContext(message, userId, correlationId) {
  const budget = createBudgetTracker(BUDGETS.user);

  // Fire all fetches in parallel — this is the key latency optimization
  const [search, pinned, history, entities, antiPatterns] = await Promise.all([
    semanticSearch(message, { limit: budget.results }),
    getPinnedMemories(userId),
    getRecentHistory(userId, 10),
    getActiveEntities(userId),
    getAntiPatterns(),
  ]);

  // Assemble under budget with priority ordering
  const parts = [];
  budget.addPart(parts, formatPinned(pinned));
  budget.addPart(parts, formatAntiPatterns(antiPatterns));

  const remaining = budget.remaining();
  budget.addPart(parts, trimToTokens(formatSearch(search), remaining));
  budget.addPart(parts, formatHistory(history));

  return buildSystemMessage(parts) + '\n\n' + message;
}
```

## Related Patterns

- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
