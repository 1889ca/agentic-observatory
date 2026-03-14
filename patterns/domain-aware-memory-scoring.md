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

### Bifurcated Vector Storage with pgvector

Vectors are stored across two PostgreSQL tables, split by the nature of the content. Documents — which carry rich metadata like project association, type, and structured content — store their embeddings inline:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents: rich metadata, embeddings stored inline
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),         -- dimensionality matches the embedding model
  project TEXT,                    -- which project this document belongs to
  type TEXT,                       -- document type (e.g., 'note', 'report', 'reference')
  access_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Memory vectors: lightweight, for non-document memories
CREATE TABLE memory_vectors (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  access_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX ON memory_vectors USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

The bifurcation exists because documents have rich metadata (project, type, etc.) that supports structured queries and filtering, while memory vectors are lightweight entries that only need content and an embedding. Both tables participate in search.

### Embedding at Write Time

When a memory is stored, the content is embedded immediately so retrieval never waits on embedding generation. The writer determines which table to target based on the content type:

```javascript
async function storeMemory(content, { project, type } = {}) {
  const embedding = await generateEmbedding(content);

  if (project || type) {
    // Document-type memory: rich metadata, stored in documents table
    await db.query(
      `INSERT INTO documents (content, embedding, project, type) VALUES ($1, $2, $3, $4)`,
      [content, JSON.stringify(embedding), project, type]
    );
  } else {
    // Lightweight memory: stored in memory_vectors table
    await db.query(
      `INSERT INTO memory_vectors (content, embedding) VALUES ($1, $2)`,
      [content, JSON.stringify(embedding)]
    );
  }
}
```

### Retrieval with Combined Scoring

Search queries both tables and merges results. Each table is queried independently using pgvector's cosine distance operator, then the combined results are re-ranked using the three-factor scoring algorithm:

```javascript
async function searchMemories(query, limit = 10) {
  const queryEmbedding = await generateEmbedding(query);
  const overfetch = limit * 3;

  // Query both tables in parallel
  const [docResults, vecResults] = await Promise.all([
    db.query(`
      SELECT id, 'document' AS source, content, created_at, access_count,
        1 - (embedding <=> $1::vector) AS similarity
      FROM documents
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), overfetch]),

    db.query(`
      SELECT id, 'memory_vector' AS source, content, created_at, access_count,
        1 - (embedding <=> $1::vector) AS similarity
      FROM memory_vectors
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), overfetch])
  ]);

  // Merge and re-rank across both sources
  const combined = [...docResults.rows, ...vecResults.rows];
  return rerank(combined).slice(0, limit);
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

Each retrieval increments the access counter on the appropriate table, creating a feedback signal for frequently-needed memories:

```javascript
async function trackAccess(results) {
  const docIds = results.filter(r => r.source === 'document').map(r => r.id);
  const vecIds = results.filter(r => r.source === 'memory_vector').map(r => r.id);

  await Promise.all([
    docIds.length && db.query(`
      UPDATE documents
      SET access_count = access_count + 1, last_accessed_at = NOW()
      WHERE id = ANY($1)
    `, [docIds]),
    vecIds.length && db.query(`
      UPDATE memory_vectors
      SET access_count = access_count + 1, last_accessed_at = NOW()
      WHERE id = ANY($1)
    `, [vecIds])
  ]);
}
```

## Implications

- pgvector's approximate nearest-neighbor search (IVFFlat) trades some accuracy for speed — exact search is available but slower for large memory stores
- The recency boost is capped at +0.1, so a highly similar old memory still beats a weakly similar new one. Similarity remains the dominant factor
- Access frequency creates a "rich get richer" effect — frequently recalled memories score higher, making them more likely to be recalled again. This is usually desirable (important memories surface) but can create blind spots
- The combined boost ceiling is +0.2, keeping vector similarity as the primary ranking signal
- Half-life tuning depends on the agent's domain: a customer support agent might use 7 days, a research agent might use 60 days
- Embedding dimensionality (1536 in the example) must match the embedding model — switching models requires re-embedding all stored memories
- Bifurcated storage means search must query both tables and merge — this adds a parallel query but keeps each table's schema clean and purpose-specific
- Documents can be filtered by project or type before vector search, narrowing the search space for domain-specific queries

## Code Example

```javascript
// Reference implementation: Riley orchestrator (PostgreSQL + pgvector)

// Store a document-type memory with project metadata
await storeMemory(
  'Deployed billing-api v2.3.1 to production. Migration ran cleanly. ' +
  'Watch for elevated error rates on the /invoices endpoint for 24 hours.',
  { project: 'billing-api', type: 'deployment-note' }
);

// Store a lightweight operational memory
await storeMemory(
  'User prefers verbose error output when running audits.'
);

// Later, retrieve relevant memories for a new task
// (searches both documents and memory_vectors, merges results)
const memories = await searchMemories(
  'Are there any known issues with the billing API?'
);

// Top result (high similarity + recent + accessed twice before):
// score: 0.84 (similarity) + 0.09 (2-day recency) + 0.02 (access) = 0.95

// Track that we used these memories (updates correct table per result)
await trackAccess(memories.slice(0, 5));
```

## Related Patterns

- [Narrative Memory Generation](./narrative-memory-generation.md)
- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
