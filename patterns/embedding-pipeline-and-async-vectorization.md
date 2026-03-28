# Embedding Pipeline and Async Vectorization

> In-memory queue with batch processing and dual storage routing, decoupling document writes from vector computation so ingestion stays fast while embeddings converge asynchronously.

## Problem

Semantic search requires vector embeddings for every document. Generating embeddings is slow -- it involves an API call to an embedding model with rate limits and variable latency. If embedding generation happens synchronously during document creation, every write operation blocks on an external API call. This makes ingestion painfully slow, creates a hard dependency on embedding API availability, and means a single API timeout can cascade into failed writes.

## Context

- A unified memory system that supports semantic search across notes, facts, todos, goals, interactions, and conversations
- Documents are created frequently from multiple sources (chat, background workers, learning pipeline)
- Embedding generation uses Google's Gemini API (`text-embedding-004`) via `GoogleGenerativeAI`
- Document-type entities store embeddings in the `documents.embedding` column; non-document types use a separate `memory_vectors` table
- Search must work even when embedding generation is temporarily unavailable
- The system should tolerate API outages without losing data or blocking writes

## Solution

### Write-First, Embed-Later

Documents are stored immediately. Embedding generation is decoupled through an in-memory queue that processes items in configurable batches:

```javascript
// lib/unified-memory/embedding-queue.js
const queue = [];
let processing = false;
let batchTimer = null;
let droppedCount = 0;

function enqueue(item) {
  // If async mode is on, skip queue and go straight to vector-memory
  if (EMBEDDING_ASYNC_ENABLED) {
    vectorMemory.storeMemory({ ...item }).catch((err) => {
      logger.error({ err, sourceType: item.sourceType }, 'Failed to enqueue embedding job');
    });
    return;
  }

  // Enforce max queue size -- drop oldest normal-priority items
  if (queue.length >= EMBEDDING_QUEUE_MAX_SIZE) {
    const normalIdx = queue.findIndex((i) => i.priority !== 'high');
    if (normalIdx !== -1) {
      queue.splice(normalIdx, 1);
      droppedCount++;
    }
  }

  // High priority items go to front of queue
  if (item.priority === 'high') {
    queue.unshift({ ...item, enqueuedAt: Date.now() });
  } else {
    queue.push({ ...item, enqueuedAt: Date.now() });
  }

  // Start batch timer if not already running
  if (!batchTimer) {
    batchTimer = setTimeout(processQueue, EMBEDDING_BATCH_INTERVAL_MS);
    batchTimer.unref?.(); // Don't keep Node alive just for queue
  }

  // If queue is full, process immediately
  if (queue.length >= EMBEDDING_BATCH_SIZE) {
    clearTimeout(batchTimer);
    processQueue();
  }
}
```

The queue is intentionally in-memory rather than DB-backed. This is a deliberate trade-off: simplicity and speed over crash recovery. Embeddings can always be regenerated from source data, so losing queued items on restart is acceptable.

### Batch Processing with Parallel Execution

The queue processor takes batches and processes them in parallel using `Promise.allSettled`, so one failed embedding doesn't block the rest:

```javascript
async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  try {
    const batch = queue.splice(0, EMBEDDING_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (item) => {
        const result = await vectorMemory.storeMemory({
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          title: item.title,
          content: item.content,
          metadata: item.metadata,
        });
        return { item, result };
      })
    );

    const stored = results.filter((r) => r.status === 'fulfilled' && r.value?.result?.stored).length;
    const failed = results.filter((r) => r.status === 'rejected' || r.value?.error).length;

    if (stored > 0 || failed > 0) {
      logger.info({ stored, failed }, 'Embedding queue batch processed');
    }
  } finally {
    processing = false;
    if (queue.length > 0) {
      batchTimer = setTimeout(processQueue, 100); // Short delay between batches
      batchTimer.unref?.();
    }
  }
}
```

### Embedding Generation with Multi-Layer Caching

The vector memory module uses Google's Gemini for embedding generation, with three cache layers to minimize redundant API calls:

```javascript
// lib/unified-memory/vector-memory.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function init() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return false;

  const modelName = process.env.RILEY_GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
  genAI = new GoogleGenerativeAI(apiKey);
  embedModel = genAI.getGenerativeModel({ model: modelName });
  return true;
}

async function getEmbedding(text, maxRetries = 3) {
  // Layer 1: Per-request cache (dedupes parallel calls within one request)
  const reqCache = requestContext.getEmbeddingCache();
  if (reqCache?.has(cacheKey)) return reqCache.get(cacheKey);

  // Layer 2: Process-wide LRU cache (configurable max size + TTL)
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  // Layer 3: In-flight deduplication (coalesce identical concurrent requests)
  const existing = inFlightEmbeddings.get(cacheKey);
  if (existing) return existing;

  // Generate with retry and exponential backoff
  const work = (async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await embedModel.embedContent(normalizedText);
        setCachedEmbedding(text, result.embedding.values);
        return result.embedding.values;
      } catch (err) {
        // Permanent disable on auth errors (401/403) or model-not-found
        if (err.status === 401 || err.status === 403) {
          disableEmbeddings('auth_error');
          throw err;
        }
        if (!isTransient(err) || attempt === maxRetries) throw err;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  })();

  inFlightEmbeddings.set(cacheKey, work);
  return work;
}
```

### Dual Storage Routing

Embeddings are routed to different storage based on source type. Document-based entities (notes, todos, goals) store embeddings directly in the `documents.embedding` column. Non-document types (facts, interactions, conversations) use the `memory_vectors` table:

```javascript
async function storeMemory({ sourceType, sourceId, title, content, metadata = {} }) {
  const textToEmbed = buildEmbeddingText(sourceType, title, content);

  // Skip very short content
  if (textToEmbed.length < EMBEDDING_MIN_CONTENT_LENGTH) {
    return { skipped: true, reason: 'too_short' };
  }

  // Content hash for change detection
  const contentHash = crypto.createHash('md5').update(textToEmbed).digest('hex');

  const vector = await getEmbedding(textToEmbed);

  // Route to appropriate storage
  if (usesDocumentEmbeddings(sourceType)) {
    // notes, todos, goals -> documents.embedding column
    await documents.setEmbedding(sourceId, vector);
    return { stored: true, storage: 'documents' };
  } else {
    // facts, interactions, conversations -> memory_vectors table
    await query(
      `INSERT INTO memory_vectors (tenant_id, source_type, source_id, title, content,
       content_hash, metadata, embedding, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (tenant_id, source_type, source_id) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         embedding = EXCLUDED.embedding,
         updated_at = NOW()`,
      [tenantId, sourceType, sourceId, title, content, contentHash, metadata, vector]
    );
    return { stored: true, storage: 'memory_vectors' };
  }
}
```

### Unified Search Across Both Stores

Search queries both storage systems and merges results into a single ranked list:

```javascript
async function search(queryText, options = {}) {
  const queryVector = await getEmbedding(queryText);
  const rawResults = [];

  // Query 1: documents.embedding (for notes, todos, goals)
  if (documentSources.length > 0) {
    const docResults = await documents.semanticSearch(queryVector, { limit, threshold });
    rawResults.push(...transformDocResults(docResults));
  }

  // Query 2: memory_vectors (for facts, interactions, conversations)
  if (legacySources.length > 0) {
    const legacyResults = await queryRead(
      `SELECT source_type, source_id, title, content, metadata,
              (embedding <=> $1) as distance
       FROM memory_vectors WHERE embedding IS NOT NULL AND tenant_id = $2
       AND source_type = ANY($3) ORDER BY embedding <=> $1 LIMIT $4`,
      [queryVector, tenantId, legacySources, limit]
    );
    rawResults.push(...legacyResults);
  }

  // Convert distance to score (0-1), filter by threshold, sort, limit
  return rawResults
    .map((r) => ({ ...r, score: 1 - r.distance / 2 }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

## Implications

- Writes are never blocked by embedding API latency -- document creation completes immediately, embedding follows asynchronously
- The in-memory queue is a deliberate simplicity trade-off: items are lost on crash, but embeddings are regenerable from source data, making this acceptable
- Priority queuing ensures high-priority items (user-initiated notes) embed before bulk imports, preventing starvation
- Queue overflow drops normal-priority items with audit logging and periodic messenger alerts (every 50 drops), providing visibility without spam
- Dual storage routing eliminates redundant embedding storage for document-based entities while maintaining backward compatibility for non-document types
- Three-layer embedding cache (per-request, process-wide LRU, in-flight dedup) minimizes API calls, especially during context assembly where the same content may be embedded multiple times
- Permanent disablement on auth/model errors prevents log spam and wasted retries when the embedding service is misconfigured, not just temporarily down
- Content hashing skips re-embedding unchanged documents, making bulk re-indexing operations efficient

## Code Example

```javascript
const { embeddingQueue } = require('./lib/unified-memory/embeddings');
const vectorMemory = require('./lib/unified-memory/vector-memory');

// Queue a note for background embedding
embeddingQueue.enqueue({
  sourceType: 'notes',
  sourceId: 42,
  title: 'Meeting with Alex',
  content: 'Discussed Q2 roadmap priorities...',
  metadata: { projectId: 5 },
  priority: 'high',
});

// Queue status monitoring
const status = embeddingQueue.getStatus();
// → { pending: 8, maxSize: 1000, processing: false, droppedCount: 0 }

// Direct embedding (synchronous path)
const vector = await vectorMemory.getEmbedding('search query text');

// Semantic search across all memory sources
const results = await vectorMemory.search('Q2 roadmap', {
  sources: ['notes', 'todos', 'facts'],
  limit: 10,
  minScore: 0.6,
});

// Force-process all queued items
await embeddingQueue.flush();
```

## Related Patterns

- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
