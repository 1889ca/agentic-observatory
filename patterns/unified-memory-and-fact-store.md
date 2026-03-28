# Unified Memory and Fact Store

> Triple-store facts (subject/predicate/object) combined with vector memory and multi-source search, providing an AI orchestrator with long-term knowledge, semantic recall, and query expansion.

## Problem

An AI orchestrator accumulates knowledge across many domains -- user preferences, project decisions, relationship context, conversation history, indexed files. Without a unified memory layer, each domain builds its own retrieval logic, search quality varies wildly, and the agent can't connect information across sources. Simple keyword search misses semantically related content, while pure vector search misses exact matches.

## Context

- An orchestrator that needs to recall facts, notes, todos, goals, interactions, conversations, and indexed files
- Knowledge has different shapes: structured facts (user preferences), semi-structured documents (notes), unstructured text (conversations)
- Some knowledge expires or gets superseded (e.g., "prefers dark mode" replaces "prefers light mode")
- Vector embeddings enable semantic search but require an external embedding model (Gemini)
- The system must degrade gracefully when the embedding model is unavailable
- Search must work across all sources with consistent scoring and ranking

## Solution

### Triple-Store Fact Schema

Facts are stored as subject/predicate/object triples with temporal validity, enabling knowledge evolution over time:

```typescript
// facts.ts
export type FactCategory = 'preference' | 'decision' | 'deadline' | 'context'
  | 'fact' | 'relationship' | 'commitment'

export async function save({
  content, category, sourceType, sourceId,
  entityId, confidence = 1.0, expiresAt,
}: SaveFactParams): Promise<string> {
  const result = await rawOne(
    `INSERT INTO facts (
      tenant_id, subject_id, subject_type, predicate,
      object_value, object_type, confidence,
      source, source_ref, valid_to
    ) VALUES (?, COALESCE(?, gen_random_uuid()), 'entity', ?, ?, 'string', ?, ?, ?, ?)
    RETURNING id`,
    [1, entityId || null, category, content, confidence,
     sourceType, sourceId || null, expiresAt || null]
  )

  const factId = result!.id as string

  // Queue for embedding (non-blocking)
  embeddingQueue.enqueue({
    sourceType: 'facts',
    sourceId: factId,
    title: `[${category}]`,
    content: content,
    metadata: { category, confidence, entityId, expiresAt },
  })

  entityEvents.created('fact', factId)
  return factId
}
```

### Fact Supersession

When knowledge changes, the old fact is temporally closed and a new one created. The old fact's embedding is deleted and a fresh one queued for the replacement:

```typescript
// facts.ts
export async function supersede(factId: string, newContent: string): Promise<string> {
  const oldFact = await get(factId)
  if (!oldFact) throw new Error(`Fact ${factId} not found`)

  // Create new fact with same metadata
  const newFactId = await save({
    content: newContent,
    category: oldFact.predicate,
    sourceType: oldFact.source || 'manual',
    entityId: oldFact.subject_id,
    confidence: oldFact.confidence,
  })

  // Mark old fact as superseded
  await raw(
    `UPDATE facts SET valid_to = NOW(), superseded_by = ?, updated_at = NOW()
     WHERE id = ?`,
    [newFactId, factId]
  )

  embeddingQueue.queueDelete('facts', factId)
  entityEvents.updated('fact', factId)
  return newFactId
}
```

### Dual-Storage Vector Memory

Embeddings are stored differently based on source type. Document-based entities (notes, todos, goals) store embeddings in the `documents.embedding` column. Non-document entities (facts, interactions, conversations) use a separate `memory_vectors` table:

```javascript
// vector-memory.js
function usesDocumentEmbeddings(sourceType) {
  return ['notes', 'todos', 'goals', 'documents'].includes(sourceType)
}

async function storeMemory({ sourceType, sourceId, title, content, metadata }) {
  const textToEmbed = buildEmbeddingText(sourceType, title, content)
  if (textToEmbed.length < EMBEDDING_MIN_CONTENT_LENGTH) {
    return { skipped: true, reason: 'too_short' }
  }

  // Content-hash change detection (memory_vectors only)
  const contentHash = crypto.createHash('md5').update(textToEmbed).digest('hex')
  if (!usesDocumentEmbeddings(sourceType)) {
    const existing = await get(
      'SELECT content_hash FROM memory_vectors WHERE source_type = $2 AND source_id = $3', ...
    )
    if (existing?.content_hash === contentHash) return { skipped: true, reason: 'unchanged' }
  }

  const vector = await getEmbedding(textToEmbed)

  // Route: document types -> documents.embedding, others -> memory_vectors
  if (usesDocumentEmbeddings(sourceType)) {
    await documents.setEmbedding(sourceId, vector)
    return { stored: true, storage: 'documents' }
  }
  await query(`INSERT INTO memory_vectors (...) ON CONFLICT DO UPDATE SET ...`, [...])
  return { stored: true, storage: 'memory_vectors' }
}
```

### Multi-Layer Search With Semantic Fallback

The unified search orchestrator tries vector search first, then falls back to keyword search across all sources. Results are merged, scored with domain-aware recency boosting, and filtered by threshold:

```javascript
// search.js
async function search(query, options = {}) {
  const domain = options.domain || detectDomain(query, { projectId, clientId })
  const threshold = options.minScore ?? getThreshold(domain)

  // Try semantic search first
  if (options.useSemanticSearch !== false) {
    const vm = getVectorMemory()
    if (vm.isAvailable()) {
      const { results } = await runSemanticSearch(vm, query, {
        sources, fetchLimit: limit * 2, finalLimit: limit,
        threshold, projectId, clientId, dateRange, domain,
      })
      if (results.length > 0) return results
    }
  }

  // Keyword fallback: search each source in parallel
  const searchPromises = []
  if (sources.includes('notes'))
    searchPromises.push(searchDocuments(query, { type: 'note', projectId }))
  if (sources.includes('facts'))
    searchPromises.push(searchFacts(query, { minScore: threshold, entityId }))
  if (sources.includes('interactions'))
    searchPromises.push(searchInteractions(query, { clientId, projectId }))
  // ... more sources

  const allResults = (await Promise.all(searchPromises)).flat()

  // Apply domain-aware recency boost BEFORE threshold filtering
  const boosted = allResults.map((r) => ({
    ...r,
    score: applyDomainRecencyBoost(r.score, r.createdAt, domain),
  }))

  return boosted
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
```

### Query Expansion

Before searching, queries are expanded with technical synonyms and entity resolution to improve recall:

```javascript
// query-expansion.js
const SYNONYMS = {
  api: ['api', 'rest', 'endpoint', 'service', 'fetch', 'request'],
  pr: ['pr', 'pull request', 'merge request', 'mr'],
  db: ['db', 'database', 'postgres', 'postgresql', 'sql'],
  auth: ['auth', 'authentication', 'authorization', 'login', 'oauth'],
  // ... more synonym groups
}

function expandQuery(query) {
  const words = query.toLowerCase().split(/\s+/)
  return words.map((word) => {
    const synonyms = SYNONYMS[word]
    return synonyms?.length > 1 ? `(${synonyms.join(' OR ')})` : word
  }).join(' ')
}

// Entity resolution: "John" -> "John Smith" if unique match
async function resolveEntities(query) {
  // ... checks each capitalized word against contacts store
  // Only expands if exactly one match to avoid ambiguity
}
```

### Embedding Cache and Deduplication

The vector memory module uses a three-layer caching strategy to minimize redundant embedding API calls. Layer 1 is a per-request cache (prevents duplicate embeds within a single request context). Layer 2 is a process-wide LRU cache (TTL-based, max 1000 entries). Layer 3 is in-flight deduplication that coalesces concurrent requests for the same text into a single API call. Only if all three miss does the system call the Gemini embedding model, with exponential backoff retry and permanent disablement on auth errors (401/403) or model-not-found (404) to prevent log spam.

## Implications

- The triple-store schema (subject/predicate/object) provides a flexible knowledge representation that can model preferences, decisions, deadlines, and relationships without schema changes
- Temporal validity (`valid_to`, `superseded_by`) means facts are never deleted -- only closed. This preserves history for debugging and audit but requires periodic cleanup of expired facts
- The dual-storage strategy (documents vs. memory_vectors) avoids duplicate embeddings for document types but adds routing complexity
- Semantic search degrades to keyword search when the embedding model is unavailable, so the system never fully breaks -- but search quality drops significantly
- Query expansion improves recall for technical queries but can introduce noise. The `(term OR synonym)` approach means PostgreSQL full-text search sees more terms to match against
- Entity resolution only fires on capitalized words with exactly one contact match, deliberately conservative to avoid false expansions
- The three-layer embedding cache (per-request, process LRU, in-flight dedup) is essential because embedding API calls are the primary cost center. Without dedup, parallel context assembly would generate redundant calls
- Content-hash change detection skips re-embedding unchanged content, but only works for memory_vectors -- documents skip this check and always update

## Code Example

```typescript
// Store a user preference as a fact
const factId = await facts.save({
  content: 'Prefers dark mode in all IDEs',
  category: 'preference',
  sourceType: 'conversation',
  confidence: 0.95,
})

// Later, when preference changes
await facts.supersede(factId, 'Switched to light mode for better readability')

// Search across all memory sources
const results = await search('IDE preferences', {
  sources: ['facts', 'notes', 'conversations'],
  limit: 5,
  useSemanticSearch: true,
})

// Get context for a conversation (uses search internally)
const context = await getContextFor('What theme does the user prefer?', {
  tokenBudget: 2000,
  includeFacts: true,
})
```

## Related Patterns

- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Embedding Pipeline and Async Vectorization](./embedding-pipeline-and-async-vectorization.md)
- [Query Builder and Fluent DB API](./query-builder-and-fluent-db-api.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
