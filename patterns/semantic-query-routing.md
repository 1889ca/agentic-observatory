# Semantic Query Routing

> Three-tier confidence-scored routing that dispatches incoming queries to hardcoded reflexes, matched skills, or the LLM — in that order — before touching the full inference pipeline.

## Problem

An orchestrator that routes every incoming query to the LLM wastes tokens and adds unnecessary latency on requests that are either trivially deterministic ("what time is it") or well-covered by an already-registered skill ("check my tasks"). Without tiered routing, the system has no way to short-circuit obvious cases, and the LLM is burdened with decisions that don't require its reasoning.

## Context

- An orchestrator receiving a continuous stream of natural-language queries of varying novelty
- A registry of pre-registered skills with declared trigger patterns and context hints
- A set of hardcoded reflexes covering frequent, fully-deterministic operations
- Confidence scoring available at query time — either from embedding similarity, keyword matching, or a combination
- The system should degrade gracefully: when nothing matches confidently, the LLM generates a novel response or pipeline rather than failing silently

## Solution

### Three-Tier Dispatch

Incoming queries are evaluated against three tiers in order. The first tier to claim the query with sufficient confidence wins; lower tiers never execute for that query.

```
Incoming Query
  |
  |-- Tier 1: Reflexes (confidence > 0.90)
  |     Hardcoded fast-paths. No LLM call. Execute directly and return.
  |
  |-- Tier 2: Skills (confidence > 0.85)
  |     Matched via embedding similarity + keyword triggers.
  |     Dispatched to the registered skill handler.
  |
  +-- Tier 3: Novel Composition (confidence < 0.85)
        Falls through to the LLM, which generates a new pipeline or response.
```

### Tier 1 — Reflexes

Reflexes are hardcoded fast-paths for operations that are both frequent and fully deterministic. They require no LLM call and no skill file — they are direct function mappings keyed on recognizable query patterns.

```javascript
// lib/router/reflexes.js
// Reflexes are registered with a match function and an executor.
// When the matcher scores above 0.90, the executor runs immediately.

const REFLEXES = [
  {
    name: 'current-time',
    // match() returns a confidence score 0-1
    match: (query) => keywordScore(query, ['what time', 'current time', 'time is it']),
    execute: () => ({ time: new Date().toISOString() }),
  },
  {
    name: 'check-tasks',
    match: (query) => keywordScore(query, ['check my tasks', 'task list', 'pending tasks']),
    execute: async (ctx) => ctx.taskStore.getPending(ctx.userId),
  },
  // Additional reflexes registered here — these are the only recognized fast-paths
];
```

Reflexes are intentionally limited in scope. Only operations that are universally safe, have no ambiguity, and produce deterministic results qualify. Any operation that varies by context or requires judgment belongs in a skill instead.

### Tier 2 — Skills

Skills are matched using a combination of embedding similarity and declared keyword triggers. The matcher scores each registered skill against the incoming query and returns the highest-scoring candidate.

```javascript
// lib/skills/matcher.js
// Scores a query against all registered skills using embedding similarity
// and keyword trigger matching, then returns the top candidate if it
// clears the confidence threshold.

async function matchSkill(query, skills, embedder) {
  const queryEmbedding = await embedder.embed(query);

  const scored = await Promise.all(
    skills.map(async (skill) => {
      // Embedding similarity against the skill's description and examples
      const embeddingScore = cosineSimilarity(queryEmbedding, skill.embedding);

      // Bonus for explicit keyword trigger matches declared in the skill manifest
      const triggerBonus = skill.triggers.some(
        (t) => query.toLowerCase().includes(t.toLowerCase())
      ) ? 0.10 : 0;

      // Context hint bonus — skill declares domain tags, query context is checked
      const contextBonus = contextOverlap(query, skill.contextHints) * 0.05;

      return {
        skill,
        score: Math.min(1, embeddingScore + triggerBonus + contextBonus),
      };
    })
  );

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0.85 ? best : null;
}
```

When a skill match is found, the query is dispatched to the skill's registered handler. The LLM is not invoked for skill routing, though individual skill handlers may call the LLM internally.

### Tier 3 — Novel Composition

Queries that do not clear either threshold fall through to the LLM. The LLM receives the full context, all available tool declarations, and is expected to either compose a new response from existing tools or generate a pipeline for the orchestrator to execute.

```javascript
// lib/router/index.js
async function route(query, ctx) {
  // Tier 1: Reflexes
  for (const reflex of REFLEXES) {
    const confidence = reflex.match(query);
    if (confidence > 0.90) {
      return await reflex.execute(ctx);
    }
  }

  // Tier 2: Skills
  const skillMatch = await matchSkill(query, ctx.skills, ctx.embedder);
  if (skillMatch) {
    return await skillMatch.skill.handler(query, ctx);
  }

  // Tier 3: Novel composition via LLM
  return await llmDispatch(query, ctx);
}
```

### Threshold Configuration

The thresholds (0.90 for reflexes, 0.85 for skills) are the current defaults and are tunable via configuration. Lowering thresholds increases routing aggressiveness — more queries are caught at upper tiers — but raises the risk of false matches. Raising thresholds pushes more traffic to the LLM, increasing cost and latency but reducing misroutes.

```javascript
// config/router.js
module.exports = {
  reflexThreshold: 0.90,  // Queries above this are reflex-executed, no LLM
  skillThreshold:  0.85,  // Queries above this are skill-dispatched
  // Queries below skillThreshold fall through to novel LLM composition
};
```

## Implications

- Reflexes eliminate LLM cost entirely for high-frequency deterministic queries — the savings compound quickly at scale
- Skill routing avoids a full LLM context assembly cycle for well-covered operations; only the skill handler runs
- The three tiers create a clear performance profile: reflexes are sub-millisecond, skill dispatch is fast, LLM fallback is slowest
- Embedding computation for skill matching adds latency at Tier 2 — if the embedder is slow, the benefit over direct LLM dispatch shrinks
- False matches at Tier 1 or Tier 2 produce wrong answers silently; threshold calibration and a held-out test set of queries are necessary to avoid regression
- Adding a reflex requires a code change and deployment; adding a skill requires only registering a new skill manifest — the operational cost of each is different
- The LLM never sees Tier 1 or Tier 2 decisions — debugging a misrouted query requires inspecting the router's confidence log, not the LLM trace
- This pattern is routing-only. It does not extract or promote skills from successful LLM interactions — that is the concern of the Skill Extraction pattern

## Code Example

```javascript
// Full routing lifecycle for an incoming query

const query = 'what time is it right now';

// Tier 1: Reflex check
// keywordScore('what time is it right now', ['what time', 'current time', 'time is it'])
// => 0.95 — above 0.90 threshold
// => current-time reflex executes immediately, returns { time: '2026-03-24T14:32:00.000Z' }
// => route() returns without touching the skill matcher or LLM

const query2 = 'summarize the pull requests from this morning';

// Tier 1: No reflex scores above 0.90 for this query
// Tier 2: matchSkill() runs embedding similarity against registered skills
//   - 'pr-summary' skill: embeddingScore 0.82 + triggerBonus 0.10 = 0.92 — match
//   => skill handler dispatched, returns PR summary
// => LLM not invoked

const query3 = 'what would happen if I deployed to prod right now given the current queue depth';

// Tier 1: No reflex match
// Tier 2: No skill clears 0.85 — highest score is 0.71 for 'deploy-check'
// Tier 3: Full LLM dispatch with tool declarations
//   => LLM reasons about queue depth tool + deploy status tool, composes a response
```

## Related Patterns

- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
