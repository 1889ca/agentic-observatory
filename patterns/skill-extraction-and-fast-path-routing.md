# Skill Extraction and Fast-Path Routing

> Embeddings-based semantic skill matching with learned reflex promotion for progressively faster dispatch.

## Problem

An LLM orchestrator processes every incoming message through the same pipeline: full context assembly, tool declaration injection, and multi-turn LLM dispatch. But many messages are repetitive — "check the deploy status", "summarize today's activity", "approve task #42". Running a full LLM cycle for well-known operations wastes tokens and adds latency. The system should learn to recognize common patterns and shortcut them.

## Context

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

### Pipeline Signature Computation

Each skill has a "pipeline signature" — the sequence of tool calls it typically produces. These are computed from historical executions:

```javascript
function computePipelineSignature(executionHistory) {
  // Group by final tool-call sequence
  const sequences = executionHistory.map(exec =>
    exec.toolCalls.map(tc => tc.name).join(' -> ')
  );

  // Find the dominant sequence
  const counts = {};
  for (const seq of sequences) {
    counts[seq] = (counts[seq] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])[0][0];
}
// Example: "entity -> memory_search -> respond"
```

### Reflex Promotion via Coactivation

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
  // Speed 1: Reflex — deterministic, no LLM
  const reflex = reflexRegistry.match(message);
  if (reflex) {
    return await executeReflex(reflex, message);
  }

  // Speed 2: Skill — matched, LLM confirms and fills gaps
  const skill = await matchSkill(message);
  if (skill && skill.confidence > 0.85) {
    return await executeWithSkillHint(skill, message);
  }

  // Speed 3: Full pipeline — novel request
  return await fullPipeline(message);
}
```

### Demotion Safety

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

- The embedding search adds ~50ms overhead to every message — acceptable given potential savings of seconds
- False skill matches can cause incorrect fast-path routing — the 0.85 threshold is tunable
- Reflex promotion creates behavior that's invisible to the LLM — debugging requires checking the reflex registry
- Pipeline signatures are brittle to tool renames — aliases help but don't fully solve this
- The system gets faster over time but also more opaque — observability is critical
- Promoted reflexes execute without LLM judgment, so they must be restricted to low-risk operations

## Code Example

```javascript
// Skill extraction from conversation history
async function extractSkills(conversations) {
  const candidates = [];

  for (const conv of conversations) {
    const toolSequence = conv.toolCalls.map(tc => tc.name);
    const signature = await computeEmbedding(conv.userMessage);

    candidates.push({
      text: conv.userMessage,
      embedding: signature,
      toolSequence,
      success: conv.exitCode === 0
    });
  }

  // Cluster by embedding similarity
  const clusters = clusterByEmbedding(candidates, { threshold: 0.88 });

  // Each cluster with 5+ successful examples becomes a skill
  return clusters
    .filter(c => c.items.length >= 5 && c.successRate > 0.9)
    .map(c => ({
      name: generateSkillName(c.items[0].text),
      signature: computePipelineSignature(c.items),
      embedding: c.centroid,
      examples: c.items.length
    }));
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
