# Embedding Pipeline and Async Vectorization

> Non-blocking embedding generation with queue-based batch processing, decoupling document writes from vector computation so ingestion stays fast and search quality converges asynchronously.

## Problem

Semantic search requires vector embeddings for every document. Generating embeddings is slow — it involves an API call to an embedding model, often with rate limits and variable latency. If embedding generation happens synchronously during document creation, every write operation blocks on an external API call. This makes ingestion painfully slow, creates a hard dependency on embedding API availability, and means a single API timeout can cascade into failed writes.

## Context

- A memory or knowledge base system that supports both keyword and semantic search
- Documents are created frequently (notes, conversation summaries, project updates)
- Embedding generation uses an external API (Gemini, OpenAI, etc.) with non-trivial latency
- Embeddings are stored in pgvector for similarity search
- Search must still work for documents that haven't been embedded yet
- The system should tolerate embedding API outages without losing data

## Solution

### Write-First, Embed-Later

Documents are stored immediately with their full content but without an embedding vector. An entry is added to the embedding queue, and the write returns without waiting:

```javascript
// lib/unified-memory/store.js
async function storeDocument(content, metadata) {
  const doc = await db.query(
    'INSERT INTO documents (content, metadata, embedding, created_at) VALUES ($1, $2, NULL, NOW()) RETURNING id',
    [content, JSON.stringify(metadata)]
  );

  await enqueueForEmbedding(doc.rows[0].id, content);

  return doc.rows[0];
}
```

### Embedding Queue

The queue is a simple database table that tracks pending embedding work. This survives process restarts — unlike an in-memory queue, nothing is lost if the worker crashes:

```javascript
// lib/unified-memory/embedding-queue.js
async function enqueueForEmbedding(docId, content) {
  await db.query(
    `INSERT INTO embedding_queue (doc_id, content, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'pending', 0, NOW())`,
    [docId, content]
  );
}

async function claimBatch(batchSize = 10) {
  const result = await db.query(
    `UPDATE embedding_queue
     SET status = 'processing', claimed_at = NOW()
     WHERE id IN (
       SELECT id FROM embedding_queue
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING doc_id, content`,
    [batchSize]
  );
  return result.rows;
}
```

### Background Worker

A background processor runs on an interval, claiming batches from the queue and generating embeddings. It processes documents in batches to amortize API overhead:

```javascript
// lib/unified-memory/embedding-worker.js
const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE) || 10;
const INTERVAL_MS = parseInt(process.env.EMBEDDING_INTERVAL_MS) || 5000;

async function processEmbeddingQueue() {
  const batch = await claimBatch(BATCH_SIZE);

  if (batch.length === 0) return;

  for (const item of batch) {
    try {
      const embedding = await generateEmbedding(item.content);

      await db.query('UPDATE documents SET embedding = $1 WHERE id = $2', [
        pgvector.toSql(embedding),
        item.doc_id,
      ]);

      await db.query("UPDATE embedding_queue SET status = 'done' WHERE doc_id = $1", [item.doc_id]);
    } catch (err) {
      await handleFailure(item.doc_id, err);
    }
  }
}

setInterval(processEmbeddingQueue, INTERVAL_MS);
```

### Embedding Generation

The actual embedding call is isolated behind a thin wrapper. Swapping embedding providers means changing one function:

```javascript
// lib/unified-memory/embeddings.js
async function generateEmbedding(text) {
  const response = await gemini.embedContent({
    model: 'text-embedding-004',
    content: { parts: [{ text }] },
  });

  return response.embedding.values;
}
```

### Failure Handling with Exponential Backoff

Failed embeddings are requeued with increasing delay. This handles transient API errors without hammering the provider:

```javascript
// lib/unified-memory/embedding-queue.js
const INITIAL_BACKOFF_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 5;

async function handleFailure(docId, error) {
  const item = await db.query('SELECT attempts FROM embedding_queue WHERE doc_id = $1', [docId]);
  const attempts = item.rows[0].attempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    await db.query(
      "UPDATE embedding_queue SET status = 'failed', attempts = $1 WHERE doc_id = $2",
      [attempts, docId]
    );
    logger.error({ docId, attempts, error: error.message }, 'Embedding permanently failed');
    return;
  }

  const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempts - 1);
  await db.query(
    `UPDATE embedding_queue SET status = 'pending', attempts = $1, next_attempt_at = NOW() + interval '1 millisecond' * $2 WHERE doc_id = $3`,
    [attempts, backoffMs, docId]
  );
}
```

### Graceful Degradation in Search

Search works in two modes depending on whether a document has an embedding. Documents without embeddings participate in keyword search only, ensuring newly created documents are still findable:

```javascript
// lib/unified-memory/search.js
async function search(query, { limit = 20 } = {}) {
  const queryEmbedding = await generateEmbedding(query);

  // Semantic search: only documents with embeddings
  const semanticResults = await db.query(
    `SELECT id, content, metadata, embedding <=> $1 AS distance
     FROM documents WHERE embedding IS NOT NULL
     ORDER BY distance ASC LIMIT $2`,
    [pgvector.toSql(queryEmbedding), limit]
  );

  // Keyword fallback: includes documents without embeddings
  const keywordResults = await db.query(
    `SELECT id, content, metadata, ts_rank(to_tsvector(content), plainto_tsquery($1)) AS rank
     FROM documents WHERE to_tsvector(content) @@ plainto_tsquery($1)
     ORDER BY rank DESC LIMIT $2`,
    [query, limit]
  );

  return mergeAndDeduplicate(semanticResults.rows, keywordResults.rows);
}
```

## Implications

- Writes are fast and never blocked by embedding API latency — document creation is O(1) relative to embedding cost
- Brand-new documents have degraded search quality (keyword-only) until their embedding is generated, typically a few seconds
- The queue table adds a small storage overhead but provides crash recovery that in-memory queues cannot
- `FOR UPDATE SKIP LOCKED` in batch claiming enables multiple workers without coordination — horizontal scaling is straightforward
- Exponential backoff prevents thundering herd on API recovery but means some documents may wait minutes for embedding after repeated failures
- The permanent failure state (`MAX_ATTEMPTS` exceeded) requires monitoring — silently dropping documents from semantic search is a data quality issue
- Swapping embedding providers (Gemini to OpenAI, local model, etc.) only requires changing `generateEmbedding` — the pipeline is provider-agnostic

## Code Example

```javascript
// Full lifecycle: store, embed asynchronously, search
async function ingestNote(content, source) {
  // 1. Store immediately (no embedding yet)
  const doc = await storeDocument(content, { source, type: 'note' });
  // doc.embedding is NULL at this point

  // 2. Background worker will pick it up within INTERVAL_MS
  // User can already find it via keyword search

  // 3. After embedding completes, semantic search includes it
  const results = await search('related concepts');
  // results may or may not include the new doc depending on timing
}

// Queue monitoring for health checks
async function getQueueStats() {
  const result = await db.query(`
    SELECT status, COUNT(*) as count
    FROM embedding_queue
    GROUP BY status
  `);
  return Object.fromEntries(result.rows.map(r => [r.status, parseInt(r.count)]));
}
// Returns: { pending: 12, processing: 3, done: 4521, failed: 2 }
```

## Related Patterns

- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
