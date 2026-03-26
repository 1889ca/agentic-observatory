# Context Assembly Pipeline

> Modular context gathering where independent context-gatherer modules each assemble their own context slice, combined at dispatch time for the final prompt.

## Problem

An orchestrator receives messages from many sources — users, scheduled tasks, internal reflections, webhook events. Each needs relevant context, but the amount and type of context differs radically. A user question needs focused search results; a periodic reflection needs broad memory access; a quick triage needs minimal context. A single monolithic pipeline with hardcoded budget allocation is rigid and hard to extend.

## Context

- An orchestrator dispatching to multiple AI models
- Multiple context sources: semantic memory, conversation history, project KBs, pinned items, vibe insights
- Each context source has its own retrieval logic, formatting, and relevance criteria
- Projects registering their own searchable knowledge bases
- Need for speed — context assembly is the primary latency contributor

## Solution

### Context Gatherer Modules

Rather than a single pipeline with budget allocation, each context source is a standalone gatherer module. Each module knows how to fetch, format, and return its own context slice:

```javascript
// context/gatherers/semantic-search.js
async function gatherSemanticContext(message) {
  const results = await semanticSearch(message, { limit: 10 });
  if (results.length === 0) return null;

  return formatSearchResults(results);
}

// context/gatherers/pinned-memories.js
async function gatherPinnedContext() {
  const pinned = await getPinnedMemories();
  if (pinned.length === 0) return null;

  return formatPinned(pinned);
}

// context/gatherers/history.js
async function gatherHistoryContext(conversationId) {
  const history = await getRecentHistory(conversationId, 10);
  if (history.length === 0) return null;

  return formatHistory(history);
}
```

### Independent Module Registry

Gatherer modules are registered and invoked independently. Each returns its context slice or null if it has nothing relevant:

```javascript
// context/index.js
const gatherers = [
  { name: 'semantic-search', fn: gatherSemanticContext },
  { name: 'pinned-memories', fn: gatherPinnedContext },
  { name: 'history',         fn: gatherHistoryContext },
  { name: 'active-entities', fn: gatherEntityContext },
  { name: 'project-context', fn: gatherProjectContext },
  { name: 'timezone',        fn: gatherTimezoneContext },
  { name: 'situational',     fn: gatherSituationalContext },
  { name: 'anti-patterns',   fn: gatherAntiPatternContext },
  { name: 'knowledge-gaps',  fn: gatherKnowledgeGapContext },
  { name: 'vibe-insights',   fn: gatherVibeContext },
];
```

### Parallel Execution

All gatherer modules are invoked concurrently. This is the critical performance optimization — sequential fetching would multiply latency:

```javascript
async function assembleContext(message, conversationId) {
  const results = await Promise.all(
    gatherers.map(async (g) => {
      try {
        const context = await g.fn(message, conversationId);
        return { name: g.name, context };
      } catch (err) {
        logger.warn({ gatherer: g.name, err }, 'Context gatherer failed');
        return { name: g.name, context: null };
      }
    })
  );

  // Filter out null results and combine
  return results
    .filter(r => r.context !== null)
    .map(r => r.context)
    .join('\n\n');
}
```

### Simple vs. Complex Classification

Messages are classified to determine whether full context assembly is needed:

```javascript
// context/classification.js
function isSimpleMessage(text) {
  if (text.length < 20) return true;
  if (SIMPLE_PATTERNS.some(p => p.test(text))) return true;
  return false;
}

// In the pipeline:
const simple = isSimpleMessage(textContent);
const context = simple
  ? null  // Skip context assembly entirely
  : await assembleContext(message, conversationId);
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

- Each gatherer module is independent — adding a new context source means adding a new module, not modifying a central pipeline
- Parallel fetching reduces latency from sum-of-all-sources to max-of-all-sources — typically 3-5x faster
- Individual gatherer failures are isolated — one module failing does not prevent the others from contributing context
- Simple message classification saves ~200-500ms by skipping context assembly entirely for trivial inputs
- Without a central budget allocator, token usage depends on what each module returns — modules must self-regulate their output size
- Anti-pattern injection into context means learned corrections are always fresh
- The modular approach trades centralized budget control for flexibility and extensibility

## Code Example

```javascript
// Complete context assembly using independent gatherer modules
async function prepareMessageWithContext(message, conversationId) {
  // Fire all gatherers in parallel — each module fetches its own context
  const results = await Promise.all(
    gatherers.map(async (g) => {
      try {
        return await g.fn(message, conversationId);
      } catch {
        return null;
      }
    })
  );

  // Combine non-null results into the final context block
  const contextBlock = results.filter(Boolean).join('\n\n');

  return contextBlock
    ? contextBlock + '\n\n' + message
    : message;
}
```

## Related Patterns

- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
