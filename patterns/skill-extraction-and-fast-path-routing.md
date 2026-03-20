# Skill Extraction and Fast-Path Routing

> Embeddings-based semantic skill matching via `skills_v2` table storage, with learned reflex promotion for progressively faster dispatch.

## Problem

An LLM orchestrator processes every incoming message through the same pipeline: full context assembly, tool declaration injection, and multi-turn LLM dispatch. But many messages are repetitive — "check the deploy status", "summarize today's activity", "approve task #42". Running a full LLM cycle for well-known operations wastes tokens and adds latency. The system should learn to recognize common patterns and shortcut them.

## Context

> **Implementation status:** Semantic skill matching is operational. Reflex promotion, demotion, and LLM-free execution are designed but not yet implemented in Riley.

- An orchestrator handling a mix of novel and repetitive user requests
- Embeddings infrastructure already in place for semantic search
- Historical conversation data showing frequently recurring patterns
- Need to balance speed (fast-path) with accuracy (no false shortcuts)
- The system should improve over time without manual programming

## Solution

### Semantic Skill Matching

When a message arrives, compute its embedding and compare against a skill signature index:

```javascript
async function matchSkill(message) {
  const embedding = await computeEmbedding(message.text);

  // Search skill signatures — pre-computed embeddings of known skill invocations
  const matches = await skillIndex.search(embedding, { topK: 3, threshold: 0.85 });

  if (matches.length === 0) return null;

  const best = matches[0];
  return {
    skill: best.skill,
    confidence: best.score,
    params: extractParams(message.text, best.skill.paramSchema)
  };
}
```

### Skills Storage: `skills_v2` Table

Skills are stored in the `skills_v2` table with embeddings as the primary identifier. The pipeline signature is computed via normalized JSON hashing of the tool-call sequence and stored alongside the embedding:

```javascript
async function upsertSkill(skill) {
  // Normalized JSON hash of the tool-call sequence — used for deduplication
  const pipelineHash = computeNormalizedHash(skill.toolSequence);

  await db.run(`
    INSERT INTO skills_v2 (name, embedding, pipeline_hash, tool_sequence, examples, success_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pipeline_hash) DO UPDATE SET
      embedding = excluded.embedding,
      examples = excluded.examples,
      success_rate = excluded.success_rate,
      updated_at = excluded.updated_at
  `, [
    skill.name,
    serializeEmbedding(skill.embedding),  // float32 array → blob
    pipelineHash,
    JSON.stringify(skill.toolSequence),
    skill.examples,
    skill.successRate,
    Date.now()
  ]);
}

function computeNormalizedHash(toolSequence) {
  // Normalize tool names and JSON-serialize for consistent hashing
  const normalized = toolSequence.map(t => t.toLowerCase().trim());
  return hashFn(JSON.stringify(normalized));
}
```

### Reflex Promotion via Coactivation

> **Aspirational:** Reflex promotion is designed but not yet implemented. The mechanism below describes the intended behavior.

When the same skill-to-tool-sequence pattern fires repeatedly with consistent results, the system promotes it to a **reflex** — a direct mapping that bypasses the LLM entirely:

```javascript
async function evaluatePromotion(skill, recentExecutions) {
  const consistencyScore = measureConsistency(recentExecutions);
  const frequency = recentExecutions.length;

  // Promote to reflex if: high consistency + sufficient frequency
  if (consistencyScore > 0.92 && frequency >= 10) {
    const reflex = {
      trigger: skill.signature,
      actions: extractDeterministicSteps(recentExecutions),
      promotedAt: Date.now(),
      confidence: consistencyScore
    };

    reflexRegistry.register(reflex);
    return reflex;
  }

  return null;
}
```

### Three-Speed Dispatch

Messages are routed through progressively faster paths:

```
Incoming Message
  |-- Reflex match? -> Execute directly (no LLM)     ~50ms
  |-- Skill match?  -> Guided LLM dispatch            ~1-2s
  +-- No match      -> Full pipeline                   ~3-5s
```

```javascript
async function dispatch(message) {
  // Speed 1: Reflex — deterministic, no LLM (ASPIRATIONAL: not yet implemented)
  const reflex = reflexRegistry.match(message);
  if (reflex) {
    return await executeReflex(reflex, message);
  }

  // Speed 2: Skill — matched, LLM confirms and fills gaps (operational)
  const skill = await matchSkill(message);
  if (skill && skill.confidence > 0.85) {
    return await executeWithSkillHint(skill, message);
  }

  // Speed 3: Full pipeline — novel request (operational)
  return await fullPipeline(message);
}
```

### Demotion Safety

> **Aspirational:** Demotion safety is designed but not yet implemented. It depends on the reflex promotion system above.

Reflexes are not permanent. If a reflex produces errors or user corrections, it's demoted back to a skill:

```javascript
function onReflexFailure(reflex, error) {
  reflex.failures = (reflex.failures || 0) + 1;

  if (reflex.failures >= 3) {
    reflexRegistry.unregister(reflex);
  }
}
```

## Implications

- The embedding search adds ~50ms overhead to every message — acceptable given potential savings of seconds. Semantic skill matching (Speed 2) is the only operational speed tier; reflex promotion (Speed 1) and LLM-free execution are designed but not yet implemented
- False skill matches can cause incorrect fast-path routing — the 0.85 threshold is tunable
- Reflex promotion, if implemented, would create behavior invisible to the LLM — debugging would require checking the reflex registry
- Pipeline signatures are stored as normalized JSON hashes — tool renames break existing hashes, requiring a re-extraction pass over history
- Currently the system improves through better skill matching, not through reflex promotion — observability remains straightforward
- Promoted reflexes, once implemented, would execute without LLM judgment and must be restricted to low-risk operations

## Code Example

```javascript
// Skill extraction from conversation history — writes to skills_v2
async function extractAndStoreSkills(conversations) {
  const candidates = [];

  for (const conv of conversations) {
    const toolSequence = conv.toolCalls.map(tc => tc.name);
    const embedding = await computeEmbedding(conv.userMessage);

    candidates.push({
      text: conv.userMessage,
      embedding,
      toolSequence,
      success: conv.exitCode === 0
    });
  }

  // Cluster by embedding similarity — each cluster is a candidate skill
  const clusters = clusterByEmbedding(candidates, { threshold: 0.88 });

  // Each cluster with 5+ successful examples becomes a skill row in skills_v2
  const skills = clusters
    .filter(c => c.items.length >= 5 && c.successRate > 0.9)
    .map(c => ({
      name: generateSkillName(c.items[0].text),
      embedding: c.centroid,          // stored as blob in skills_v2
      toolSequence: dominantSequence(c.items),
      examples: c.items.length,
      successRate: c.successRate
    }));

  for (const skill of skills) {
    await upsertSkill(skill);  // writes to skills_v2 with normalized pipeline_hash
  }

  return skills;
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
