# Knowledge Graph and Relationship Discovery

> Extract, store, and traverse entity relationships from conversations to surface connections an agent wouldn't otherwise recall.

## Problem

Agents process conversations containing rich entity references — people, projects, concepts, tools — and the relationships between them. Without structured storage, these connections are lost after the conversation ends. The agent can't answer "how is Alice connected to Project X?" or "what concepts cluster around this topic?" because it never captured those relationships. Over time, the agent accumulates thousands of interactions but can't map the web of connections within them.

## Context

- An agent handling conversations across multiple domains (work, personal, technical)
- Entities appear repeatedly across conversations but aren't explicitly linked
- Users expect the agent to "know" that certain people, projects, and concepts are related
- The agent needs to surface relevant connections when assembling context for a new interaction
- Historical relationship patterns (who worked with whom, what depends on what) are valuable for planning and recommendations

## Solution

### Entity Extraction

As conversations flow through the agent, extract entities and their relationships. Entities have types (person, project, concept, tool, organization) and relationships have types (works-on, related-to, depends-on, mentioned-with) plus a strength score.

```javascript
async function extractEntities(message) {
  const extraction = await model.send(`
    Extract entities and relationships from this message.
    Return JSON: { entities: [{ name, type }], relationships: [{ from, to, type }] }
    Entity types: person, project, concept, tool, organization
    Relationship types: works-on, related-to, depends-on, mentioned-with
  `, { content: message });

  return JSON.parse(extraction);
}
```

### Graph Storage

Store entities as nodes and relationships as edges in PostgreSQL. Each edge carries a strength score that increases with repeated observation and decays over time.

```sql
CREATE TABLE kg_nodes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,       -- person, project, concept, tool, org
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  UNIQUE(name, type)
);

CREATE TABLE kg_edges (
  id SERIAL PRIMARY KEY,
  from_node INTEGER REFERENCES kg_nodes(id),
  to_node INTEGER REFERENCES kg_nodes(id),
  relationship TEXT NOT NULL,  -- works-on, related-to, depends-on
  strength FLOAT DEFAULT 1.0,
  observation_count INTEGER DEFAULT 1,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_node, to_node, relationship)
);

CREATE INDEX idx_edges_from ON kg_edges(from_node);
CREATE INDEX idx_edges_to ON kg_edges(to_node);
CREATE INDEX idx_edges_strength ON kg_edges(strength DESC);
```

### Relationship Strength Scoring

Strength is reinforced on each observation and decays with time. This ensures frequently-referenced relationships surface first, while stale connections fade.

```javascript
async function upsertRelationship(fromId, toId, type) {
  await db.query(`
    INSERT INTO kg_edges (from_node, to_node, relationship, strength, observation_count)
    VALUES ($1, $2, $3, 1.0, 1)
    ON CONFLICT (from_node, to_node, relationship) DO UPDATE SET
      strength = LEAST(kg_edges.strength + 0.3, 5.0),
      observation_count = kg_edges.observation_count + 1,
      last_seen = NOW()
  `, [fromId, toId, type]);
}

function decayStrength(daysSinceLastSeen) {
  // Half-life of ~30 days
  return Math.pow(0.977, daysSinceLastSeen);
}
```

### Multi-Hop Traversal

To discover indirect connections, traverse the graph multiple hops out from a starting entity. Each hop reduces the effective strength, so direct connections rank higher than indirect ones.

```javascript
async function expandGraph(entityName, maxHops = 3, minStrength = 0.3) {
  const visited = new Set();
  const connections = [];

  async function traverse(nodeId, depth, pathStrength) {
    if (depth > maxHops || visited.has(nodeId)) return;
    visited.add(nodeId);

    const edges = await db.query(`
      SELECT e.*, n.name, n.type
      FROM kg_edges e
      JOIN kg_nodes n ON n.id = CASE
        WHEN e.from_node = $1 THEN e.to_node
        ELSE e.from_node
      END
      WHERE (e.from_node = $1 OR e.to_node = $1)
        AND e.strength * $2 >= $3
      ORDER BY e.strength DESC
      LIMIT 20
    `, [nodeId, decayStrength(daysSince(edge.last_seen)), minStrength]);

    for (const edge of edges.rows) {
      const effectiveStrength = edge.strength * pathStrength * (1 / depth);
      connections.push({
        entity: edge.name,
        type: edge.type,
        relationship: edge.relationship,
        strength: effectiveStrength,
        hops: depth
      });
      await traverse(edge.id, depth + 1, effectiveStrength);
    }
  }

  const startNode = await findNode(entityName);
  if (startNode) await traverse(startNode.id, 1, 1.0);

  return connections.sort((a, b) => b.strength - a.strength);
}
```

### Context Enrichment

When assembling context for a new interaction, query the knowledge graph for entities mentioned in the current message. The returned connections provide the agent with relationship awareness it wouldn't have from memory search alone.

```javascript
async function enrichWithGraph(message, contextBudget) {
  const entities = await extractEntities(message);
  const graphContext = [];

  for (const entity of entities.entities) {
    const connections = await expandGraph(entity.name, 2);
    if (connections.length > 0) {
      graphContext.push({
        entity: entity.name,
        connections: connections.slice(0, 5) // top 5 connections per entity
      });
    }
  }

  return formatGraphContext(graphContext, contextBudget);
}
```

## Implications

- Entity extraction is imperfect — the model will miss entities or create duplicates with slightly different names (requires normalization)
- Graph queries add latency to context assembly; cache frequently-accessed subgraphs
- Strength decay parameters need tuning — too aggressive and useful connections vanish, too slow and noise accumulates
- Multi-hop traversal can explode combinatorially; depth and breadth limits are essential
- The graph is only as good as the conversations flowing through it — gaps in conversation coverage mean gaps in the graph
- Privacy-sensitive: the graph captures who is connected to what, so access control and data retention policies apply
- Periodic pruning of low-strength, stale edges keeps the graph manageable

## Code Example

```javascript
// Full pipeline: extract from conversation, store, and query
async function processConversation(message) {
  // Extract entities and relationships
  const { entities, relationships } = await extractEntities(message);

  // Upsert nodes
  const nodeIds = {};
  for (const entity of entities) {
    nodeIds[entity.name] = await upsertNode(entity.name, entity.type);
  }

  // Upsert edges with strength reinforcement
  for (const rel of relationships) {
    await upsertRelationship(
      nodeIds[rel.from],
      nodeIds[rel.to],
      rel.type
    );
  }

  // Query for context enrichment — "who/what is connected to these entities?"
  const connections = await expandGraph(entities[0]?.name, 2);

  return {
    directConnections: connections.filter(c => c.hops === 1),
    indirectConnections: connections.filter(c => c.hops > 1)
  };
}
```

## Related Patterns

- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
