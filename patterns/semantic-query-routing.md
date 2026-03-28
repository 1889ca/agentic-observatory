# Semantic Query Routing

> Embedding-similarity skill matching with pgvector, two confidence thresholds (0.90 reflex, 0.85 skill), automatic hit/success tracking, and a graduation path from trial to reflex status.

## Problem

An orchestrator that routes every incoming query to the LLM wastes tokens and adds unnecessary latency on requests that are either trivially deterministic or well-covered by an already-registered skill. Without tiered routing, the system has no way to short-circuit obvious cases, and the LLM is burdened with decisions that don't require its reasoning.

## Context

- An orchestrator receiving a continuous stream of natural-language queries of varying novelty
- A `skills_v2` table in PostgreSQL with pgvector embeddings for each skill
- Skills have lifecycle statuses: `trial` (newly created), `stable` (proven), and `reflex` (auto-execute)
- Embedding generation is available via the unified memory module
- The system should degrade gracefully: when nothing matches confidently, the LLM generates a novel response

## Solution

### Two-Tier Confidence Dispatch

The skill matcher (`lib/skills/matcher.js`) generates an embedding for the incoming query and searches the `skills_v2` table using pgvector cosine distance. Two thresholds determine the routing action:

```javascript
// lib/skills/matcher.js
const { getEmbedding } = require('../unified-memory/vector-memory')
const { raw } = require('../db/query-handler')

const REFLEX_THRESHOLD = 0.90  // Auto-execute without LLM
const SKILL_THRESHOLD  = 0.85  // Include in LLM context

async function match(queryText) {
  const queryEmbedding = await getEmbedding(queryText)

  // Search reflexes first (highest priority)
  const reflexResults = await searchSkills(queryEmbedding, 1, ['reflex'], 1)

  if (reflexResults.length > 0 && reflexResults[0].score > REFLEX_THRESHOLD) {
    return {
      type: 'reflex',
      match: reflexResults[0],
      action: 'execute',
      confidence: reflexResults[0].score,
    }
  }

  // Search stable and trial skills
  const skillResults = await searchSkills(queryEmbedding, 1, ['stable', 'trial'], 5)
  const relevant = skillResults.filter((s) => s.score > SKILL_THRESHOLD)

  if (relevant.length > 0) {
    return {
      type: 'skills',
      matches: relevant.slice(0, 3),  // Top 3
      action: 'include_in_context',
      topScore: relevant[0].score,
    }
  }

  return { type: 'none', matches: [], action: 'compose_novel' }
}
```

### pgvector Similarity Search

The search query uses PostgreSQL's `<=>` cosine distance operator and converts distance to a 0-1 similarity score:

```javascript
// lib/skills/matcher.js
async function searchSkills(embedding, tenantId, statuses, limit) {
  const sql = `
    SELECT
      id, name, description, pipeline, example_queries,
      status, hit_count, success_count,
      (embedding <=> $1) as distance
    FROM skills_v2
    WHERE tenant_id = $2
      AND embedding IS NOT NULL
      AND status = ANY($3)
    ORDER BY embedding <=> $1
    LIMIT $4
  `

  const results = await raw(sql, [
    JSON.stringify(embedding),
    tenantId,
    statuses,
    limit,
  ])

  return results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    pipeline: r.pipeline,
    exampleQueries: r.example_queries,
    status: r.status,
    hitCount: r.hit_count,
    successCount: r.success_count,
    score: 1 - r.distance / 2,  // Cosine distance → similarity
  }))
}
```

### Three Routing Actions

The matcher returns one of three action types:

| Score | Status | Action | What happens |
|---|---|---|---|
| > 0.90 | reflex | `execute` | Skill pipeline runs directly, no LLM |
| > 0.85 | stable/trial | `include_in_context` | Top 3 skills added to LLM context |
| < 0.85 | - | `compose_novel` | Full LLM dispatch with all tools |

Reflexes bypass the LLM entirely — they execute their stored pipeline directly. Skills above 0.85 are injected into the LLM's context as hints, letting the model leverage known capabilities without being forced into a specific path. Queries below 0.85 fall through to full novel composition.

### Hit and Success Tracking

Every skill match is recorded for metrics and graduation decisions:

```javascript
// lib/skills/matcher.js
async function recordMatch(skillId, success) {
  if (success) {
    await raw(
      `UPDATE skills_v2
       SET hit_count = hit_count + 1,
           success_count = success_count + 1,
           last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [skillId, tenantId]
    )
  } else {
    await raw(
      `UPDATE skills_v2
       SET hit_count = hit_count + 1,
           last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [skillId, tenantId]
    )
  }
}
```

### Skill Creation with Centroid Embeddings

New skills are created from repeated pipeline patterns. The embedding is a centroid (average) of multiple example query embeddings, which improves match breadth:

```javascript
// lib/skills/matcher.js
async function createSkill({ name, description, pipeline, exampleQueries }) {
  // Generate centroid embedding from example queries
  const embeddings = await Promise.all(exampleQueries.map((q) => getEmbedding(q)))
  const centroid = averageVectors(embeddings)

  const result = await raw(
    `INSERT INTO skills_v2 (tenant_id, name, description, pipeline, embedding, example_queries, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'trial')
     RETURNING id`,
    [tenantId, name, description, JSON.stringify(pipeline), JSON.stringify(centroid), exampleQueries]
  )

  return { id: result[0]?.id, created: true }
}

function averageVectors(vectors) {
  if (vectors.length <= 1) return vectors[0] || []
  const dim = vectors[0].length
  const result = new Array(dim).fill(0)
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) result[i] += vec[i]
  }
  for (let i = 0; i < dim; i++) result[i] /= vectors.length
  return result
}
```

### Graduation: Trial to Stable to Reflex

Skills begin as `trial`, graduate to `stable` after proving reliability, and can be promoted to `reflex` for zero-LLM execution:

```javascript
// lib/skills/matcher.js
async function promoteToReflex(skillId) {
  await raw(
    `UPDATE skills_v2
     SET status = 'reflex', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [skillId, tenantId]
  )
  return { promoted: true }
}
```

Promotion decisions are based on `hit_count` and `success_count` ratios — a skill needs both volume and accuracy to earn reflex status.

## Implications

- Reflexes eliminate LLM cost entirely for high-frequency deterministic queries — the savings compound quickly at scale
- Embedding computation for every query adds latency at the routing layer — typically 50-200ms for the embedding call plus the pgvector search
- Centroid embeddings from multiple examples provide broader match coverage than a single-query embedding, but can become too generic if examples are diverse
- The 0.90/0.85 thresholds are tunable but sensitive — lowering them increases routing aggressiveness and false matches; raising them pushes more traffic to the expensive LLM path
- False matches at the reflex tier produce wrong answers silently since no LLM reviews the result — threshold calibration is critical
- The `skills_v2` table is tenant-scoped, supporting multi-tenant deployments where each tenant has different skill sets
- Trial skills participate in context inclusion (0.85 threshold) but not reflex execution (0.90), providing a safe proving ground
- `getTopSkills()` retrieves the most-used skills for inclusion in general system context, independent of query matching

## Code Example

```javascript
// Full routing lifecycle
const matcher = require('../skills/matcher')

async function routeQuery(queryText) {
  const result = await matcher.match(queryText)

  switch (result.action) {
    case 'execute':
      // Reflex: run pipeline directly, record success
      const output = await executePipeline(result.match.pipeline)
      await matcher.recordMatch(result.match.id, true)
      return output

    case 'include_in_context':
      // Skills found: inject into LLM context
      const skillContext = result.matches.map((s) =>
        `Available skill: ${s.name} - ${s.description}`
      ).join('\n')
      return await llmGenerate(queryText, { additionalContext: skillContext })

    case 'compose_novel':
      // No matches: full LLM dispatch
      return await llmGenerate(queryText)
  }
}
```

## Related Patterns

- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
- [Embedding Pipeline and Async Vectorization](./embedding-pipeline-and-async-vectorization.md)
- [LLM Adapter Facade](./llm-adapter-facade.md)
