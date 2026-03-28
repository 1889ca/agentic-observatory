# Knowledge Graph and Relationship Discovery

> Document-based entity relationships with dedicated scoring, enrichment, and query modules for multi-hop traversal, relationship ranking by type/recency/strength, and context assembly integration.

## Problem

An orchestrator processes conversations containing references to entities and the relationships between them. Without structured storage, these connections are lost after the conversation ends. The agent can't answer "what is related to this entity?" or "what depends on this?" because it never captured those relationships.

## Context

- A general-purpose agent that discovers and stores arbitrary entities from conversations
- Entities are stored as documents in a unified `documents` table with UUID primary keys
- Relationships are stored in `document_relationships` with typed edges and strength properties
- Users expect the agent to know relationships between entities it has encountered
- The knowledge graph module is read-oriented — it queries and scores existing relationships rather than performing continuous extraction
- A modular architecture with separate files for queries, scoring, and enrichment

## Solution

### Module Architecture

The knowledge graph is organized as a directory with four files:

- `index.js` — main API (`getEntityContext`, `getNeighborhood`, `findPath`, `enrichContext`)
- `queries.js` — raw SQL queries against `documents` and `document_relationships`
- `scoring.js` — relationship and fact relevance scoring with type weights and recency decay
- `enrichment.js` — formats graph data for context assembly with token budget awareness

### Document-Based Entity Storage

Entities are stored in the `documents` table — the same table used for memory and knowledge. Relationships are stored in `document_relationships` with typed edges and strength stored in a JSONB `properties` column:

```sql
-- documents table (UUID primary keys)
SELECT id, type, data->>'name' as name, data FROM documents WHERE id = $1;

-- document_relationships with strength in properties
SELECT
  r.id, r.source_id, r.target_id, r.relationship_type,
  COALESCE((r.properties->>'strength')::real, 1.0) as strength,
  r.created_at as last_seen,
  CASE WHEN r.source_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction,
  d.id as related_entity_id, d.data->>'name' as related_name, d.type as related_type
FROM document_relationships r
JOIN documents d ON (
  (r.source_id = $1 AND r.target_id = d.id) OR
  (r.target_id = $1 AND r.source_id = d.id)
)
WHERE (r.source_id = $1 OR r.target_id = $1)
  AND COALESCE((r.properties->>'strength')::real, 1.0) >= $2
```

### Relationship Type Scoring

The scoring module assigns weights to relationship types and calculates composite scores from strength, type weight, and recency:

```javascript
// lib/knowledge-graph/scoring.js
const TYPE_WEIGHTS = {
  works_on: 1.0,
  owns: 0.95,
  client_of: 0.9,
  employed_by: 0.85,
  works_with: 0.8,
  manages: 0.75,
  depends_on: 0.6,
  related_to: 0.4,
  mentioned_with: 0.3,
};

function scoreRelationship(relationship) {
  const strength = relationship.strength || 0.5;
  const typeWeight = TYPE_WEIGHTS[relationship.relationship_type] || 0.4;
  const recencyFactor = calculateRecencyDecay(relationship.last_seen, 30); // 30-day half-life

  // Composite: 50% strength, 30% type weight, 20% recency
  return strength * 0.5 + typeWeight * 0.3 + recencyFactor * 0.2;
}
```

Recency uses exponential decay with a configurable half-life (30 days for relationships, 60 days for facts):

```javascript
function calculateRecencyDecay(lastSeen, halfLifeDays = 30) {
  if (!lastSeen) return 0.5;
  const daysSince = (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0.1, Math.min(1.0, Math.pow(0.5, daysSince / halfLifeDays)));
}
```

### Entity Context (Read-Oriented)

The main `getEntityContext()` function is read-oriented — it queries an entity's direct relationships, scores and ranks them, and fetches related facts. It does not perform extraction:

```javascript
// lib/knowledge-graph/index.js
async function getEntityContext(documentId, options = {}) {
  const { depth = 1, minStrength = 0.3, limit = 10 } = options;

  const doc = await query(
    "SELECT id, type, data->>'name' as name, data FROM documents WHERE id = $1",
    [documentId]
  );

  // Get direct relationships (more than needed, then score and filter)
  const rawRelationships = await queries.getDirectRelationships(documentId, {
    minStrength, limit: limit * 2,
  });

  // Score and rank
  const relationships = scoring.rankRelationships(rawRelationships, {
    minScore: 0.2, limit,
  });

  // Get facts for related entities
  const relatedDocIds = relationships.map(r => r.related_entity_id);
  const relatedFacts = relatedDocIds.length > 0
    ? await queries.getRelatedFacts(relatedDocIds, 3) : [];

  // Score facts by relationship relevance and depth
  const scoredFacts = scoring.rankFacts(relatedFacts, entityScores, entityDepths, {
    minScore: 0.15, limit: 10,
  });

  return { entity: { id, name, type }, relationships, relatedFacts: scoredFacts };
}
```

### Multi-Hop Traversal

The `getNeighborhood()` function expands outward from seed entities through multiple hops, tracking path strength at each level:

```javascript
async function getNeighborhood(documentId, options = {}) {
  const { depth = 2, minStrength = 0.3, limit = 50 } = options;
  return queries.getNeighborhood([documentId], { depth, minStrength, limit });
}
```

### Context Enrichment

The enrichment module transforms raw graph data into formatted context suitable for inclusion in the system prompt. It accepts a token budget and truncates if needed:

```javascript
// lib/knowledge-graph/enrichment.js
async function getEnrichedContext(mentionedEntities, options = {}) {
  const { depth = 1, minStrength = 0.5, tokenBudget = 300 } = options;

  const entityIds = mentionedEntities.map(e => e.id).filter(Boolean);
  const neighborhood = await queries.getNeighborhood(entityIds, { depth, minStrength, limit: 20 });

  // Get and score relationships, then facts
  // Format into human-readable context
  const formatted = formatForContext({ relationships, facts });

  // Estimate tokens (1 token per 4 chars) and truncate if over budget
  const tokens = Math.ceil(formatted.length / 4);
  if (tokens > tokenBudget) {
    return { content: formatted.substring(0, tokenBudget * 4) + '...', tokens: tokenBudget };
  }
  return { content: formatted, tokens };
}
```

The formatted output groups relationships by source entity and includes related facts:

```
[Related context from knowledge graph]
- Connections: Sarah Chen (is a client of), Website Redesign (works on)
- Sarah Chen: Prefers email communication, timezone PST
```

### Graph Utilities

Additional graph operations support relationship exploration:

```javascript
// Find shortest path between two entities
async function findPath(documentA, documentB) { /* ... */ }

// Find common connections between entities
async function findCommonConnections(documentA, documentB) { /* ... */ }

// Get strongest relationships for an entity
async function getStrongestRelationships(documentId, limit = 10) { /* ... */ }
```

## Implications

- The knowledge graph is read-oriented — `getEntityContext()` queries existing relationships rather than extracting new ones from conversation text
- Separate `scoring.js` and `enrichment.js` modules keep concerns clean — scoring is reusable across different query paths
- Type-weighted scoring means some relationship types (works_on, owns) are inherently more relevant than others (mentioned_with), which may not suit all domains
- Exponential recency decay with a 30-day half-life means relationships not refreshed in ~2 months decay to 25% relevance
- Token budget awareness in enrichment prevents graph context from consuming the entire context window
- All entity IDs are UUIDs (not integers), reflecting the document-based storage model
- Multi-hop traversal can grow combinatorially — depth and breadth limits are essential
- The graph module does not own entity extraction — that happens elsewhere in the pipeline, and the graph provides the query/scoring layer

## Code Example

```javascript
// Context assembly integration
const kg = require('./lib/knowledge-graph');

async function assembleContext(message, mentionedEntities) {
  // Get enriched graph context for mentioned entities
  const graphContext = await kg.enrichContext(
    mentionedEntities.map(e => e.id),
    { depth: 1, minStrength: 0.5, factLimit: 5 }
  );

  // Returns: { entities, relationships, facts } with scores

  // Or get detailed context for a single entity
  const entityContext = await kg.getEntityContext(entityId, {
    depth: 1, minStrength: 0.3, limit: 10,
  });

  // entityContext.relationships[0]:
  // { target: { id, name: 'Sarah Chen', type: 'person' },
  //   type: 'client_of', direction: 'outgoing', strength: 0.85, score: 0.72 }
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
