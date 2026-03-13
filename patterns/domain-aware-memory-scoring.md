# Domain-Aware Memory Scoring

> Score memory relevance using semantic similarity, recency decay, and access frequency rather than raw vector distance alone.

## Problem

Embedding-based memory retrieval returns results by cosine similarity, but raw similarity is not enough. A highly similar memory from three months ago is often less useful than a moderately similar one from yesterday. Similarly, memories that the agent frequently retrieves are likely more operationally important than those retrieved once. Without combined scoring, retrieval returns stale or rarely-used matches alongside fresh, relevant ones, polluting the agent's context window.

## Context

- Semantic memory systems using vector embeddings for storage and retrieval
- Agents that accumulate memories over weeks or months of operation
- Systems where temporal relevance matters — recent context is usually more actionable
- Retrieval budgets are limited (context windows have finite space), so ranking quality matters

## Solution

### Vector Storage with pgvector

Memories are stored in PostgreSQL with embeddings generated at write time using pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),         -- dimensionality matches the embedding model
  access_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

-- Index for fast approximate nearest-neighbor search
CREATE INDEX ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

### Embedding at Write Time

When a memory is stored, the content is embedded immediately so retrieval never waits on embedding generation:

```javascript
async function storeMemory(content) {
  const embedding = await generateEmbedding(content);
  await db.query(
    `INSERT INTO memories (content, embedding) VALUES ($1, $2)`,
    [content, JSON.stringify(embedding)]
  );
}
```

### Retrieval with Combined Scoring

Queries are embedded and compared against stored memories using pgvector's cosine distance operator. The database handles the vector math; application code layers on recency and frequency:

```javascript
async function searchMemories(query, limit = 10) {
  const queryEmbedding = await generateEmbedding(query);

  // pgvector cosine distance: 1 - cosine_similarity
  // So similarity = 1 - distance
  const results = await db.query(`
    SELECT
      id, content, created_at, access_count,
      1 - (embedding <=> $1::vector) AS similarity
    FROM memories
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [JSON.stringify(queryEmbedding), limit * 3]); // over-fetch for re-ranking

  return rerank(results.rows);
}
```

### Three-Factor Scoring

The final score combines semantic similarity, recency decay, and access frequency:

```javascript
function rerank(memories) {
  return memories
    .map(m => ({
      ...m,
      score: combinedScore(m.similarity, m.created_at, m.access_count),
    }))
    .sort((a, b) => b.score - a.score);
}

function combinedScore(similarity, createdAt, accessCount) {
  const recency = recencyDecay(createdAt);
  const recencyBoost = recency * 0.1;                       // up to +0.1 for fresh memories
  const accessBoost = Math.min(0.1, accessCount * 0.01);    // up to +0.1 for frequently accessed
  return similarity + recencyBoost + accessBoost;
}
```

### Exponential Recency Decay

Recency uses an exponential half-life curve. The half-life is configurable — shorter for fast-moving operational contexts, longer for reference knowledge:

```javascript
const HALF_LIFE_DAYS = 14;

function recencyDecay(createdAt) {
  const halfLifeMs = HALF_LIFE_DAYS * 86400000;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return Math.pow(0.5, ageMs / halfLifeMs);
}
// 14-day-old memory: decay factor = 0.5
// 28-day-old memory: decay factor = 0.25
// 1-day-old memory:  decay factor ~= 0.95
```

### Access Tracking

Each retrieval increments the access counter, creating a feedback signal for frequently-needed memories:

```javascript
async function trackAccess(memoryIds) {
  await db.query(`
    UPDATE memories
    SET access_count = access_count + 1, last_accessed_at = NOW()
    WHERE id = ANY($1)
  `, [memoryIds]);
}
```

## Implications

- pgvector's approximate nearest-neighbor search (IVFFlat) trades some accuracy for speed — exact search is available but slower for large memory stores
- The recency boost is capped at +0.1, so a highly similar old memory still beats a weakly similar new one. Similarity remains the dominant factor
- Access frequency creates a "rich get richer" effect — frequently recalled memories score higher, making them more likely to be recalled again. This is usually desirable (important memories surface) but can create blind spots
- The combined boost ceiling is +0.2, keeping vector similarity as the primary ranking signal
- Half-life tuning depends on the agent's domain: a customer support agent might use 7 days, a research agent might use 60 days
- Embedding dimensionality (1536 in the example) must match the embedding model — switching models requires re-embedding all stored memories

## Code Example

```javascript
// Reference implementation: Riley orchestrator (PostgreSQL + pgvector)

// Store a memory after a work session
await storeMemory(
  'Deployed billing-api v2.3.1 to production. Migration ran cleanly. ' +
  'Watch for elevated error rates on the /invoices endpoint for 24 hours.'
);

// Later, retrieve relevant memories for a new task
const memories = await searchMemories(
  'Are there any known issues with the billing API?'
);

// Top result (high similarity + recent + accessed twice before):
// score: 0.84 (similarity) + 0.09 (2-day recency) + 0.02 (access) = 0.95

// Track that we used these memories
await trackAccess(memories.slice(0, 5).map(m => m.id));
```

## Related Patterns

- [Narrative Memory Generation](./narrative-memory-generation.md)
- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
