# Domain-Aware Memory Scoring

> Embedding similarity from vector search plus a recency boost for time-aware memory retrieval — a simpler model than originally envisioned.

## Problem

Embedding-based memory retrieval returns results by cosine similarity, but raw similarity is not enough. A highly similar memory from three months ago is often less useful than a moderately similar one from yesterday. Without any temporal signal, retrieval returns stale matches alongside fresh ones, polluting the agent's context window with outdated information.

## Context

- Semantic memory systems using vector embeddings for storage and retrieval
- Agents that accumulate memories over weeks or months of operation
- Systems where temporal relevance matters — recent context is usually more actionable
- Retrieval budgets are limited (context windows have finite space), so ranking quality matters

## Solution

### Bifurcated Vector Storage with pgvector

Vectors are stored across two PostgreSQL tables, split by the nature of the content. Documents carry rich metadata like project association and type. Memory vectors are lightweight entries for non-document memories:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents: rich metadata, embeddings stored inline
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  project TEXT,
  type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Memory vectors: lightweight, for non-document memories
CREATE TABLE memory_vectors (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON memory_vectors USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

### Embedding at Write Time

When a memory is stored, the content is embedded immediately so retrieval never waits on embedding generation:

```javascript
async function storeMemory(content, { project, type } = {}) {
  const embedding = await generateEmbedding(content);

  if (project || type) {
    await db.query(
      `INSERT INTO documents (content, embedding, project, type) VALUES ($1, $2, $3, $4)`,
      [content, JSON.stringify(embedding), project, type]
    );
  } else {
    await db.query(
      `INSERT INTO memory_vectors (content, embedding) VALUES ($1, $2)`,
      [content, JSON.stringify(embedding)]
    );
  }
}
```

### Retrieval with Recency Boost

Search queries both tables and merges results. Each table is queried independently using pgvector's cosine distance operator, then results are re-ranked by applying a recency boost to the raw similarity score:

```javascript
async function searchMemories(query, limit = 10) {
  const queryEmbedding = await generateEmbedding(query);
  const overfetch = limit * 3;

  // Query both tables in parallel
  const [docResults, vecResults] = await Promise.all([
    db.query(`
      SELECT id, 'document' AS source, content, created_at,
        1 - (embedding <=> $1::vector) AS similarity
      FROM documents
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), overfetch]),

    db.query(`
      SELECT id, 'memory_vector' AS source, content, created_at,
        1 - (embedding <=> $1::vector) AS similarity
      FROM memory_vectors
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [JSON.stringify(queryEmbedding), overfetch])
  ]);

  // Merge and re-rank with recency boost
  const combined = [...docResults.rows, ...vecResults.rows];
  return applyRecencyBoost(combined).slice(0, limit);
}
```

### Recency Boost

The only post-retrieval scoring adjustment is a recency boost. This applies an exponential decay based on memory age, nudging fresher memories higher in the results:

```javascript
const HALF_LIFE_DAYS = 14;

function applyRecencyBoost(memories) {
  return memories
    .map(m => ({
      ...m,
      score: m.similarity + recencyBoost(m.created_at),
    }))
    .sort((a, b) => b.score - a.score);
}

function recencyBoost(createdAt) {
  const halfLifeMs = HALF_LIFE_DAYS * 86400000;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  return decay * 0.1; // up to +0.1 for very fresh memories
}

// 1-day-old memory:  boost ~= 0.095
// 14-day-old memory: boost = 0.05
// 28-day-old memory: boost = 0.025
```

The boost is capped at +0.1, so similarity remains the dominant ranking factor. A highly similar old memory still beats a weakly similar new one.

## Implications

- The scoring model is simpler than a full multi-factor system — only similarity and recency are used, with no access frequency tracking
- pgvector's approximate nearest-neighbor search (IVFFlat) trades some accuracy for speed — exact search is available but slower for large memory stores
- The recency boost is small (+0.1 max), keeping vector similarity as the primary ranking signal while giving fresh memories a meaningful edge
- Half-life tuning depends on the agent's domain: a customer support agent might use 7 days, a research agent might use 60 days
- Embedding dimensionality (1536 in the example) must match the embedding model — switching models requires re-embedding all stored memories
- Bifurcated storage means search must query both tables and merge — this adds a parallel query but keeps each table's schema clean and purpose-specific
- Documents can be filtered by project or type before vector search, narrowing the search space for domain-specific queries
- Access frequency tracking and combined multi-factor scoring were originally envisioned but are not implemented — the simpler model has proven sufficient for current needs

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
// (searches both documents and memory_vectors, merges with recency boost)
const memories = await searchMemories(
  'Are there any known issues with the billing API?'
);

// Top result (high similarity + recent):
// score: 0.84 (similarity) + 0.09 (2-day recency boost) = 0.93
```

## Related Patterns

- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
