# Context Assembly Pipeline

> Token-budgeted context assembler with lazy-loaded modules, priority-ordered parts, and parallel async fetching that allocates a finite token budget across 10+ context sources based on query analysis.

## Problem

An orchestrator receives messages that need context -- relevant memories, entity facts, preferences, recent conversation, knowledge graph connections, prefetched data. But context has a hard ceiling: the model's context window is finite and every token spent on context is a token unavailable for reasoning. Without a budget-aware assembler, the system either overstuffs context (wasting tokens on low-value information) or underfills it (missing critical facts). The assembler needs to prioritize, budget, and parallelize.

## Context

- A model with a configurable token budget (typically 2000-4000 tokens for context)
- 10+ context sources, each with different retrieval latency and value
- Query analysis that determines which sources are relevant (a recall query needs semantic search; a quick greeting does not)
- Need for speed: context assembly is the primary latency contributor before response generation
- Sources that depend on query analysis results (entity facts) and sources that are independent (preferences)

## Solution

### Budget Tracker

The assembler uses a budget tracker that allocates tokens from a finite pool. Each context source requests a portion; the tracker ensures the total never exceeds the budget:

```javascript
// lib/context/optimizer.js
function createBudgetTracker(totalBudget) {
  let used = 0;
  let remaining = totalBudget;

  return {
    get used() { return used; },
    get remaining() { return remaining; },
    consume(tokens) {
      if (tokens > remaining) return false;  // Over budget
      used += tokens;
      remaining -= tokens;
      return true;
    },
    getAllocation(requested) {
      return Math.min(requested, remaining);
    },
  };
}
```

### Lazy-Loaded Modules

The assembler avoids loading all context modules at startup. Modules are lazy-loaded on first use and cached:

```javascript
// lib/context/assembler.js
const lazy = {
  facts: null,
  memory: null,
  preferences: null,
  vectorMemory: null,
  config: null,
  voice: null,
};

function get(name, path) {
  if (!lazy[name]) {
    try {
      lazy[name] = require(path);
    } catch (err) {
      lazy[name] = null;  // Module unavailable — skip silently
    }
  }
  return lazy[name];
}
```

This means a context source that is not installed (e.g., vector memory not configured) is silently skipped rather than causing an error.

### Three-Phase Assembly

Context assembly runs in three phases, reflecting data dependencies:

```javascript
// lib/context/index.js
async function assembleContext(message, options = {}) {
  const budget = createBudgetTracker(tokenBudget);
  const parts = [];

  // Phase 1: Query analysis (others depend on this)
  const analysis = await analyzeQuery(message);
  // Returns: { type, mentionedEntities, topics, timeContext }

  // Phase 2: Synchronous/fast operations that depend on analysis
  if (pendingContext)
    addPart('session_context', 1, formatPendingContext(pendingContext, ...));
  if (sessionId)
    addPart('episode_context', 2, getEpisodeContext(sessionId, budget.getAllocation(200)));
  if (analysis.mentionedEntities.length > 0)
    addPart('entity_facts', 3, getEntityFacts(analysis.mentionedEntities, budget.getAllocation(300)));

  // Phase 3: Async fetches in PARALLEL
  const asyncFetches = [];
  asyncFetches.push(getVoiceContext(150).then(r => ({ type: 'voice', priority: 0.5, result: r })));
  asyncFetches.push(proactiveMemory.getSessionContext({ ... }).then(r => ({ ... })));
  asyncFetches.push(getSemanticMemories(message, ...).then(r => ({ ... })));
  asyncFetches.push(getRelevantPreferences(analysis.type, ...).then(r => ({ ... })));
  asyncFetches.push(getRecentConversation(sessionId, ...).then(r => ({ ... })));
  // ... knowledge graph, reactive memory, prefetched context, user preferences

  const asyncResults = await Promise.all(asyncFetches);
  for (const item of asyncResults) {
    if (item?.result) addPart(item.type, item.priority, item.result);
  }

  // Sort by priority and assemble
  parts.sort((a, b) => a.priority - b.priority);
  return { context: parts.map(p => p.content).join('\n\n'), analysis };
}
```

### Priority Ordering

Each context part has a numeric priority (lower = higher importance). Parts are sorted by priority before assembly, ensuring the most important context appears first in the prompt:

| Priority | Context Type | Rationale |
|----------|-------------|-----------|
| 0.5 | Voice context, recent conversation | Prevents hallucinations about what was just said |
| 1 | Session context (pending) | Active session state |
| 1.5 | Prefetched context | Proactively gathered (meeting prep, etc.) |
| 2 | Episode context | Current conversation thread |
| 2.5 | Proactive memory | Topically relevant memories surfaced in advance |
| 2.7 | Reactive memory | Memories triggered by entity mentions |
| 3 | Entity facts | Facts about people/projects mentioned |
| 3.5 | Knowledge graph | Relationship context for mentioned entities |
| 4 | Semantic memories | Vector-search results for the query |
| 5 | Past episodes | Related conversation history |
| 6 | Preferences | User preference context |
| 6.2 | User explicit preferences | Stated preferences (always included) |

### Conditional Fetching

Not all sources are fetched for every message. Query analysis determines which sources to skip:

```javascript
const shouldDeepSearch = analysis.type === 'recall' || messageLength >= MIN_SEMANTIC_CHARS;
const shouldProactive = analysis.type === 'recall' || messageLength >= MIN_PROACTIVE_CHARS
  || (analysis.topics || []).length > 0;

// Semantic memories only fetched for substantial queries
if (shouldDeepSearch) {
  asyncFetches.push(getSemanticMemories(message, ...));
}

// Proactive memory skipped for very short low-signal messages
if (shouldProactive) {
  asyncFetches.push(proactiveMemory.getSessionContext({ ... }));
}

// Knowledge graph only when entities are mentioned
if (analysis.mentionedEntities.length > 0) {
  asyncFetches.push(getEnrichedContext(analysis.mentionedEntities, { depth: 1, minStrength: 0.5 }));
}
```

### Source-Tagged Content

Each context source tags its output with provenance markers so the LLM can distinguish database facts from inferred preferences:

```javascript
// Entity facts tagged with source
'[DB:fact:John Smith] Works at Acme Corp as CTO'

// Preferences tagged by source type
'[PREF:workflow] preferred_editor: VSCode'
'[PREF_INFERRED:communication] tone: casual'
'[PREF_EXPLICIT:notification] digest_frequency: daily'

// Semantic memories tagged
'[DB:notes:42] Meeting notes from Q4 planning session'

// Prefetched context tagged
'[PREFETCH:meeting_participants] John Smith (CTO) at Acme Corp'
'[PREFETCH:project_status] Project "Billing": 12/20 tasks done (60%)'
```

### Caching

Assembled context is cached with a composite key (tenant, session, budget, message hash, pending context hash) and a configurable TTL:

```javascript
async function getContextFor(message, options) {
  if (cache.isEnabled()) {
    const cacheKey = cache.buildKey([
      'context', tenantId, sessionId || 'none', tokenBudget,
      cache.hash(message), pendingHash
    ]);
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const { context } = await assembleContext(message, options);
    await cache.set(cacheKey, context, CONTEXT_CACHE_TTL_SECONDS);
    return context;
  }

  const { context } = await assembleContext(message, options);
  return context;
}
```

### Output Format

The final context is wrapped in minimal framing that lets the LLM distinguish context from the user's message:

```javascript
function formatForMessage(message, context) {
  if (!context?.trim()) return message;
  return `[MEMORY]\n${context}\n\n[USER MESSAGE]\n${message}`;
}
```

## Implications

- Parallel fetching reduces latency from sum-of-all-sources to max-of-all-sources: typically 3-5x faster than sequential
- Budget tracking prevents context overflow but does not guarantee optimal allocation: a large entity facts block can consume budget that would be better spent on semantic memories
- Lazy-loaded modules mean a missing dependency (e.g., vector memory not configured) causes silent degradation, not crashes
- Short messages skip expensive context sources (semantic search, proactive memory), saving both latency and tokens
- Priority ordering is static: the assembler always prioritizes recent conversation (0.5) over semantic memories (4), regardless of query type. This is a deliberate trade-off favoring recency over relevance
- Source tags add a few tokens of overhead per context block but prevent the LLM from confusing facts (verified) with inferences (uncertain)
- Cache invalidation is hash-based: identical messages in the same session get cached results, but any change to pending context or session state invalidates the cache
- Individual source failures are caught and swallowed: one broken source does not prevent the others from contributing

## Code Example

```javascript
// Context assembly for a message mentioning a person and a project

const result = await assembleContext('What's the status on the billing project? Has John reviewed it?', {
  sessionId: 'sess-42',
  tokenBudget: 3000,
});

// result.analysis:
// {
//   queryType: 'project',
//   mentionedEntities: [{ type: 'person', name: 'John' }, { type: 'project', name: 'billing' }],
//   topics: ['billing', 'review'],
// }

// result.context (assembled, priority-ordered):
// [CONV:recent] User said "Deploy the fix" → Riley said "Deployed to staging"
//
// [PREFETCH:project_status] Project "Billing": 18/25 tasks done. 2 blocked.
//
// [DB:fact:John] Senior engineer, handles billing-api reviews
// [DB:fact:billing] Main repo: org/billing-api, branch: main
//
// [DB:notes:89] John approved the pricing refactor PR last week
//
// [PREF_EXPLICIT:workflow] preferred_branch_strategy: feature-branches

// result.analysis.contextParts:
// [
//   { type: 'recent_conversation', tokens: 85 },
//   { type: 'prefetched_context', tokens: 45 },
//   { type: 'entity_facts', tokens: 120 },
//   { type: 'semantic_memories', tokens: 95 },
//   { type: 'user_preferences', tokens: 30 },
// ]
// usedTokens: 375, remainingBudget: 2625
```

## Related Patterns

- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
