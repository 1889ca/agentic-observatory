# Knowledge Graph and Relationship Discovery

> Extract, store, and traverse entity relationships using document embeddings and a triple-store to surface connections an agent wouldn't otherwise recall.

## Problem

Agents process conversations containing rich entity references — people, projects, concepts, tools — and the relationships between them. Without structured storage, these connections are lost after the conversation ends. The agent can't answer "how is Alice connected to Project X?" or "what concepts cluster around this topic?" because it never captured those relationships. Over time, the agent accumulates thousands of interactions but can't map the web of connections within them.

## Context

- An agent handling conversations across multiple domains (work, personal, technical)
- Entities appear repeatedly across conversations but aren't explicitly linked
- Users expect the agent to "know" that certain people, projects, and concepts are related
- The agent needs to surface relevant connections when assembling context for a new interaction
- Historical relationship patterns (who worked with whom, what depends on what) are valuable for planning and recommendations
- Knowledge documents already exist with embeddings for semantic search — the graph layer augments rather than replaces them

## Solution

### Document-Based Entity Storage

Rather than maintaining separate node and edge tables, entities are stored as documents with embeddings. This means every entity participates in the same semantic search infrastructure used for memory retrieval — no parallel system to maintain.

```sql
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,          -- 'entity', 'memory', 'knowledge', etc.
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}', -- { entity_type: 'person', aliases: [...] }
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE document_relationships (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES documents(id),
  target_id INTEGER REFERENCES documents(id),
  relationship TEXT NOT NULL,   -- works-on, related-to, depends-on
  strength FLOAT DEFAULT 1.0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_id, target_id, relationship)
);

CREATE INDEX idx_rel_source ON document_relationships(source_id);
CREATE INDEX idx_rel_target ON document_relationships(target_id);
CREATE INDEX idx_rel_strength ON document_relationships(strength DESC);
```

### Fact Triple-Store

Alongside document relationships, a triple-store captures structured knowledge extracted from conversations. Each fact is a subject-predicate-object triple — lightweight, queryable, and independent of the document graph.

```sql
CREATE TABLE facts (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence FLOAT DEFAULT 1.0,
  source TEXT,                  -- conversation id, flow id, etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_facts_subject ON facts(subject);
CREATE INDEX idx_facts_predicate ON facts(predicate);
CREATE INDEX idx_facts_object ON facts(object);
```

Facts and document relationships serve different purposes. Facts capture declarative knowledge ("Alice manages Project X"), while document relationships capture structural connections with strength scoring. Both are queried during context enrichment.

### Entity Extraction and Storage

As conversations flow through the agent, extract entities, relationships, and facts. Entities become documents; connections become document relationships; declarative statements become facts.

```javascript
async function extractAndStore(message, conversationId) {
  const extraction = await model.send(`
    Extract from this message:
    1. entities: [{ name, type, description }]
    2. relationships: [{ from, to, type }]
    3. facts: [{ subject, predicate, object }]
    Entity types: person, project, concept, tool, organization
    Relationship types: works-on, related-to, depends-on, mentioned-with
  `, { content: message });

  const parsed = JSON.parse(extraction);

  // Upsert entities as documents
  const docIds = {};
  for (const entity of parsed.entities) {
    docIds[entity.name] = await upsertEntityDocument(entity);
  }

  // Upsert document relationships with strength reinforcement
  for (const rel of parsed.relationships) {
    await upsertRelationship(docIds[rel.from], docIds[rel.to], rel.type);
  }

  // Insert facts as triples
  for (const fact of parsed.facts) {
    await upsertFact(fact.subject, fact.predicate, fact.object, conversationId);
  }
}
```

### Relationship Strength Scoring

Strength is reinforced on each observation and decays with time. This ensures frequently-referenced relationships surface first, while stale connections fade.

> **Note:** The decay formula and reinforcement increment shown here represent the designed behavior. The core relationship upsert with `ON CONFLICT` strength reinforcement is confirmed; the specific decay half-life and increment values may differ from what's shown.

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

function decayStrength(daysSinceLastUpdate) {
  // Half-life of ~30 days
  return Math.pow(0.977, daysSinceLastUpdate);
}
```

### Multi-Hop Traversal

To discover indirect connections, traverse document relationships multiple hops out from a starting entity. Each hop reduces the effective strength, so direct connections rank higher than indirect ones.

> **Note:** The traversal parameters and depth limits shown here represent the designed behavior. Core entity and fact storage is confirmed in the implementation; specific traversal tuning (max hops, minimum strength thresholds) may vary.

```javascript
async function expandGraph(documentId, maxHops = 3, minStrength = 0.3) {
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
        AND dr.strength * $2 >= $3
      ORDER BY dr.strength DESC
      LIMIT 20
    `, [docId, pathStrength, minStrength]);

    for (const rel of rels.rows) {
      const age = daysSince(rel.updated_at);
      const effectiveStrength = rel.strength * decayStrength(age) * (1 / depth);
      connections.push({
        entity: rel.title,
        type: rel.metadata?.entity_type,
        relationship: rel.relationship,
        strength: effectiveStrength,
        hops: depth
      });
      const nextId = rel.source_id === docId ? rel.target_id : rel.source_id;
      await traverse(nextId, depth + 1, effectiveStrength);
    }
  }

  await traverse(documentId, 1, 1.0);
  return connections.sort((a, b) => b.strength - a.strength);
}
```

### Context Enrichment

When assembling context for a new interaction, query both document relationships and the fact triple-store. Document relationships reveal the structural graph around mentioned entities. Fact queries surface declarative knowledge that may not appear in the relationship graph at all.

```javascript
async function enrichWithGraph(message, contextBudget) {
  const entities = await extractEntities(message);
  const graphContext = [];

  for (const entity of entities) {
    const doc = await findEntityDocument(entity.name);
    if (!doc) continue;

    // Graph traversal for structural connections
    const connections = await expandGraph(doc.id, 2);

    // Fact queries for declarative knowledge
    const facts = await db.query(`
      SELECT * FROM facts
      WHERE subject = $1 OR object = $1
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 10
    `, [entity.name]);

    graphContext.push({
      entity: entity.name,
      connections: connections.slice(0, 5),
      facts: facts.rows
    });
  }

  return formatGraphContext(graphContext, contextBudget);
}
```

## Implications

- Entity extraction is imperfect — the model will miss entities or create duplicates with slightly different names (requires normalization)
- Storing entities as documents means they participate in semantic search, but also means the documents table grows with every new entity
- The facts table can accumulate contradictory triples ("Alice manages Project X" and "Bob manages Project X") — conflict resolution is left to the consumer
- Graph queries add latency to context assembly; cache frequently-accessed subgraphs
- Strength decay parameters need tuning — too aggressive and useful connections vanish, too slow and noise accumulates
- Multi-hop traversal can explode combinatorially; depth and breadth limits are essential
- Two query paths (document relationships + facts) provide richer context but increase query complexity
- The graph is only as good as the conversations flowing through it — gaps in conversation coverage mean gaps in the graph
- Privacy-sensitive: the graph captures who is connected to what, so access control and data retention policies apply
- Periodic pruning of low-strength relationships and low-confidence facts keeps the system manageable

## Code Example

```javascript
// Full pipeline: extract from conversation, store, and query
async function processConversation(message, conversationId) {
  // Extract and store entities, relationships, and facts
  await extractAndStore(message, conversationId);

  // Query for context enrichment
  const entities = await extractEntities(message);
  if (!entities.length) return { connections: [], facts: [] };

  const doc = await findEntityDocument(entities[0].name);
  if (!doc) return { connections: [], facts: [] };

  const connections = await expandGraph(doc.id, 2);

  // Query facts about the primary entity
  const facts = await db.query(`
    SELECT subject, predicate, object, confidence
    FROM facts
    WHERE subject = $1 OR object = $1
    ORDER BY confidence DESC
    LIMIT 10
  `, [entities[0].name]);

  return {
    directConnections: connections.filter(c => c.hops === 1),
    indirectConnections: connections.filter(c => c.hops > 1),
    facts: facts.rows
  };
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
