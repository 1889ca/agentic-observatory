# Contradiction Detection and Resolution

> Identify conflicting learned patterns in the memory system and resolve them via majority voting or recency weighting to prevent accumulation of contradictory rules.

## Problem

A learning system that continuously absorbs patterns from operational data will inevitably accumulate contradictions. One learned rule might say "user prefers concise responses" while another says "user wants detailed explanations." Without detection and resolution, the system oscillates between contradictory behaviors or applies whichever rule happens to be retrieved first — making behavior unpredictable and eroding user trust.

## Context

- An AI agent with a persistent learning/memory system that stores behavioral rules derived from user feedback and operational patterns
- Rules are learned incrementally over time, often from different contexts
- The system cannot simply overwrite old rules — the old rule may still be valid in its original context
- Needs to work at storage time (proactive) and retrieval time (reactive) to catch contradictions before they affect behavior

## Solution

A contradiction detector scans incoming learned patterns against the existing rule set. It uses semantic similarity to find candidate conflicts, then applies structured comparison to determine if two rules genuinely contradict. Resolution uses a combination of majority voting (if multiple rules agree on a direction) and recency weighting (newer observations get a boost).

### Detection Phase

When a new pattern is learned, the detector retrieves semantically similar existing rules and checks for logical conflicts:

```javascript
// lib/learning/contradiction.js — illustrative
async function detectContradictions(newRule, existingRules) {
  // Find rules in the same domain (e.g., both about "response style")
  const candidates = existingRules.filter(
    rule => cosineSimilarity(newRule.embedding, rule.embedding) > 0.75
  );

  const conflicts = [];

  for (const candidate of candidates) {
    const comparison = await compareRules(newRule, candidate);

    if (comparison.contradicts) {
      conflicts.push({
        existing: candidate,
        new: newRule,
        confidence: comparison.confidence,
        dimension: comparison.dimension, // e.g., "verbosity", "formality"
      });
    }
  }

  return conflicts;
}
```

### Resolution Phase

When contradictions are found, the resolver applies a voting + recency strategy:

```javascript
async function resolveContradiction(conflict, allRules) {
  const { existing, new: newRule, dimension } = conflict;

  // Gather all rules that speak to this dimension
  const voters = allRules.filter(
    r => r.dimensions?.includes(dimension)
  );

  // Majority voting: which direction do most rules point?
  const tally = { agree_new: 0, agree_existing: 0 };
  for (const voter of voters) {
    const alignment = await checkAlignment(voter, newRule, existing);
    tally[alignment]++;
  }

  // Recency boost: newer observations get 1.5x weight
  const recencyBoost = 1.5;
  const newScore = tally.agree_new * recencyBoost;
  const existingScore = tally.agree_existing;

  if (newScore > existingScore) {
    // New rule wins — mark existing as superseded
    await markSuperseded(existing.id, newRule.id);
    return { winner: 'new', action: 'supersede' };
  } else {
    // Existing rule wins — discard new rule
    return { winner: 'existing', action: 'discard' };
  }
}
```

### Lifecycle Integration

Contradiction detection runs at two points:

1. **On learn** — when a new rule is about to be stored, detect and resolve before persisting
2. **On retrieval** — when multiple rules are retrieved for a context, filter out superseded rules

```javascript
async function learnPattern(pattern) {
  const existing = await getRelatedRules(pattern);
  const conflicts = await detectContradictions(pattern, existing);

  for (const conflict of conflicts) {
    const resolution = await resolveContradiction(conflict, existing);
    logger.info('Contradiction resolved', {
      dimension: conflict.dimension,
      winner: resolution.winner,
    });
  }

  // Only store if not discarded
  if (!conflicts.some(c => c.resolution?.action === 'discard')) {
    await storeRule(pattern);
  }
}
```

## Implications

- Prevents the "rule soup" problem where contradictory learned behaviors accumulate over time
- Recency weighting means the system naturally adapts to changing user preferences without manual cleanup
- Majority voting adds stability — a single contradictory observation doesn't override well-established patterns
- Semantic similarity threshold (0.75) is a tuning knob: too low catches false positives, too high misses real conflicts
- Superseded rules are marked, not deleted — preserving audit trail and enabling rollback
- The LLM comparison step (`compareRules`) adds latency to the learning path, but learning is infrequent relative to retrieval

## Code Example

```javascript
// User says "keep it brief" — but system previously learned "provide detailed explanations"
const newRule = {
  content: 'User prefers concise, brief responses',
  dimensions: ['verbosity'],
  learnedAt: new Date(),
};

const conflicts = await detectContradictions(newRule, existingRules);
// → [{ existing: { content: 'Provide detailed explanations' }, dimension: 'verbosity' }]

const resolution = await resolveContradiction(conflicts[0], existingRules);
// → { winner: 'new', action: 'supersede' }
// Old "detailed" rule is marked superseded; new "brief" rule is stored
```

## Related Patterns

- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
