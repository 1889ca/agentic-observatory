# Knowledge Graph and Relationship Discovery

> Domain-specific entity relationships for gigs, venues, and performers stored in the documents table with relationship scoring and multi-hop traversal.

## Problem

An orchestrator managing a music/entertainment domain processes conversations containing references to gigs, venues, performers, and the relationships between them. Without structured storage, these connections are lost after the conversation ends. The agent can't answer "which performers have played at this venue?" or "what gigs are coming up at venues near downtown?" because it never captured those relationships.

## Context

- A domain-specific agent focused on gigs, venues, and performers
- Entities appear repeatedly across conversations but aren't explicitly linked
- Users expect the agent to know relationships between performers, venues, and gigs
- The agent needs to surface relevant connections when assembling context for a new interaction
- Knowledge documents already exist with embeddings for semantic search — the graph layer augments rather than replaces them

## Solution

### Document-Based Entity Storage

Entities are stored in the `documents` table — the same table used for memory and knowledge. There is no separate fact store or triple-store. Every entity participates in the same semantic search infrastructure:

```sql
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,          -- 'entity', 'memory', 'knowledge', etc.
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}', -- { entity_type: 'venue', domain: 'music', ... }
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE document_relationships (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES documents(id),
  target_id INTEGER REFERENCES documents(id),
  relationship TEXT NOT NULL,   -- performs-at, booked-for, managed-by
  strength FLOAT DEFAULT 1.0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id, relationship)
);
```

### Domain-Specific Entity Types

The entity types are domain-specific, not generic:

```javascript
const ENTITY_TYPES = {
  PERFORMER: 'performer',  // Bands, solo artists, DJs
  VENUE: 'venue',          // Clubs, bars, concert halls
  GIG: 'gig',             // Specific performances / bookings
  PROMOTER: 'promoter',   // Event organizers
};

const RELATIONSHIP_TYPES = {
  PERFORMS_AT: 'performs-at',     // performer -> venue
  BOOKED_FOR: 'booked-for',     // performer -> gig
  HOSTED_AT: 'hosted-at',       // gig -> venue
  PROMOTED_BY: 'promoted-by',   // gig -> promoter
  MANAGED_BY: 'managed-by',     // performer -> promoter
};
```

### Entity Extraction and Storage

Extraction is tuned for the music/entertainment domain:

```javascript
async function extractAndStore(message, conversationId) {
  const extraction = await model.send(`
    Extract from this message:
    1. entities: [{ name, type, description }]
    2. relationships: [{ from, to, type }]
    Entity types: performer, venue, gig, promoter
    Relationship types: performs-at, booked-for, hosted-at, promoted-by, managed-by
  `, { content: message });

  const parsed = JSON.parse(extraction);

  // Upsert entities as documents
  const docIds = {};
  for (const entity of parsed.entities) {
    docIds[entity.name] = await upsertEntityDocument(entity);
  }

  // Upsert relationships with strength reinforcement
  for (const rel of parsed.relationships) {
    await upsertRelationship(docIds[rel.from], docIds[rel.to], rel.type);
  }
}
```

### Relationship Strength Scoring

Strength is reinforced on each observation. The scoring is simpler than a generic system — reinforcement on repeat observations, basic time decay:

```javascript
async function upsertRelationship(sourceId, targetId, type) {
  await db.query(`
    INSERT INTO document_relationships (source_id, target_id, relationship, strength)
    VALUES ($1, $2, $3, 1.0)
    ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
      strength = LEAST(document_relationships.strength + 0.3, 5.0),
      updated_at = NOW()
  `, [sourceId, targetId, type]);
}
```

### Multi-Hop Traversal

To discover indirect connections (e.g., "which performers share venues?"), traverse relationships multiple hops:

```javascript
async function expandGraph(documentId, maxHops = 2, minStrength = 0.3) {
  const visited = new Set();
  const connections = [];

  async function traverse(docId, depth, pathStrength) {
    if (depth > maxHops || visited.has(docId)) return;
    visited.add(docId);

    const rels = await db.query(`
      SELECT dr.*, d.title, d.metadata
      FROM document_relationships dr
      JOIN documents d ON d.id = CASE
        WHEN dr.source_id = $1 THEN dr.target_id
        ELSE dr.source_id
      END
      WHERE (dr.source_id = $1 OR dr.target_id = $1)
        AND dr.strength >= $2
      ORDER BY dr.strength DESC
      LIMIT 20
    `, [docId, minStrength]);

    for (const rel of rels.rows) {
      connections.push({
        entity: rel.title,
        type: rel.metadata?.entity_type,
        relationship: rel.relationship,
        strength: rel.strength,
        hops: depth
      });
      const nextId = rel.source_id === docId ? rel.target_id : rel.source_id;
      await traverse(nextId, depth + 1, rel.strength);
    }
  }

  await traverse(documentId, 1, 1.0);
  return connections.sort((a, b) => b.strength - a.strength);
}
```

### Context Enrichment

When assembling context for a new interaction, query document relationships for the mentioned entities:

```javascript
async function enrichWithGraph(message, contextBudget) {
  const entities = await extractEntities(message);
  const graphContext = [];

  for (const entity of entities) {
    const doc = await findEntityDocument(entity.name);
    if (!doc) continue;

    const connections = await expandGraph(doc.id, 2);

    graphContext.push({
      entity: entity.name,
      connections: connections.slice(0, 5),
    });
  }

  return formatGraphContext(graphContext, contextBudget);
}
```

## Implications

- Entity extraction is imperfect — the model will miss entities or create duplicates with slightly different names (requires normalization)
- Storing entities in the `documents` table means they participate in semantic search, but also means the table grows with every new entity
- Domain-specific entity types (performer, venue, gig) make extraction more accurate but limit reuse outside the entertainment domain
- No separate fact/triple store — all knowledge is captured through document relationships, keeping the schema simpler
- Graph queries add latency to context assembly; cache frequently-accessed subgraphs
- Multi-hop traversal can grow combinatorially; depth and breadth limits are essential
- The graph is only as good as the conversations flowing through it — gaps in conversation coverage mean gaps in the graph

## Code Example

```javascript
// Full pipeline: extract from conversation, store, and query
async function processConversation(message, conversationId) {
  await extractAndStore(message, conversationId);

  const entities = await extractEntities(message);
  if (!entities.length) return { connections: [] };

  const doc = await findEntityDocument(entities[0].name);
  if (!doc) return { connections: [] };

  const connections = await expandGraph(doc.id, 2);

  return {
    directConnections: connections.filter(c => c.hops === 1),
    indirectConnections: connections.filter(c => c.hops > 1),
  };
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
