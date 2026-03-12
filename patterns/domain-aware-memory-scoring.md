# Domain-Aware Memory Scoring

> Score memory relevance using domain-specific thresholds and recency decay rather than raw similarity alone.

## Problem

Embedding-based memory retrieval returns results by cosine similarity, but raw similarity is domain-blind. A 0.7 similarity match about a health concern is much more important than a 0.7 match about a casual social interaction. Similarly, a work memory from yesterday is more relevant than one from three months ago, but a health memory might stay relevant for weeks. Without domain awareness, retrieval treats all memories equally, returning stale social chatter alongside critical operational context.

## Context

- Semantic memory systems using vector embeddings for retrieval
- Agents operating across multiple domains (work, personal, health, finance, social, learning, creative)
- Systems where memory relevance depends on both content match and temporal freshness
- Agents that need to prioritize what they recall based on the domain of the current query

## Solution

### Domain Detection via Keywords

Each memory is classified into a domain using keyword matching:

```javascript
const DOMAINS = {
  work:     { threshold: 0.70, decayDays: 30, keywords: ['deploy', 'merge', 'refactor', 'api', 'bug', 'feature', 'pr', 'build', 'test'] },
  personal: { threshold: 0.60, decayDays: 14, keywords: ['preference', 'like', 'dislike', 'want', 'habit', 'routine'] },
  health:   { threshold: 0.80, decayDays: 30, keywords: ['health', 'doctor', 'medication', 'exercise', 'sleep'] },
  finance:  { threshold: 0.85, decayDays: 30, keywords: ['budget', 'invoice', 'payment', 'subscription', 'cost'] },
  social:   { threshold: 0.50, decayDays: 7,  keywords: ['meeting', 'call', 'chat', 'message', 'email', 'slack'] },
  learning: { threshold: 0.65, decayDays: 14, keywords: ['learn', 'study', 'research', 'course', 'tutorial'] },
  creative: { threshold: 0.55, decayDays: 21, keywords: ['creative', 'writing', 'story', 'novel', 'design', 'art', 'music'] },
};
```

Key design choices per domain:
- **Threshold**: Higher = stricter. Health (0.80) and finance (0.85) require strong matches to avoid false positives on sensitive topics. Social (0.50) is permissive because social context is broadly useful.
- **Decay days**: Half-life for recency scoring. Social memories (7 days) decay fast; work and health (30 days) persist longer.

### Three-Factor Scoring

Final memory scores combine similarity, recency, and access frequency:

```javascript
function scoreMemory(similarity, createdAt, domain, accessCount = 0) {
  const recency = recencyFactor(createdAt, domain);
  const recencyBoost = recency * 0.1;                    // Up to +0.1 for fresh memories
  const accessBoost = Math.min(0.1, accessCount * 0.01); // Up to +0.1 for frequently accessed
  return similarity + recencyBoost + accessBoost;
}
```

### Exponential Recency Decay

Recency uses an exponential half-life curve tuned per domain:

```javascript
function recencyFactor(createdAt, domain) {
  const halfLife = (DOMAINS[domain]?.decayDays ?? 14) * 86400000;
  const age = Date.now() - new Date(createdAt).getTime();
  return Math.pow(0.5, age / halfLife);
}
// A work memory at 30 days old → recencyFactor = 0.5
// A social memory at 7 days old → recencyFactor = 0.5
// A social memory at 14 days old → recencyFactor = 0.25
```

### Threshold Filtering

After scoring, memories below their domain threshold are excluded from retrieval results. This prevents low-confidence matches from polluting context windows:

```javascript
const threshold = getThreshold(domain); // e.g., 0.85 for finance
const results = candidates.filter(m => m.score >= threshold);
```

## Implications

- Domain detection is keyword-based, not semantic — a memory about "the cost of the deploy" could be classified as finance or work depending on which keywords dominate
- The threshold/decay tuning reflects one agent's operational priorities; different agents would need different parameters
- Access frequency boost creates a "rich get richer" effect — frequently recalled memories score higher, which makes them more likely to be recalled again
- The maximum combined boost from recency + access is +0.2, keeping domain threshold as the primary quality gate
- No cross-domain boosting — a memory relevant to both work and health uses whichever domain it was classified into
- Default threshold (0.65) and decay (14 days) provide reasonable fallbacks for unclassified memories

## Code Example

```javascript
// Retrieving memories for a work query
const query = 'What happened with the billing service deployment?';
const embedding = await embed(query);

const candidates = memories.map(m => ({
  ...m,
  similarity: cosineSimilarity(embedding, m.embedding),
  domain: detectDomain(m.content),
}));

const scored = candidates.map(m => ({
  ...m,
  score: scoreMemory(m.similarity, m.created_at, m.domain, m.access_count),
}));

// Filter by domain threshold, sort by score
const results = scored
  .filter(m => m.score >= getThreshold(m.domain))
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);
```

## Related Patterns

- [Narrative Memory Generation](./narrative-memory-generation.md)
- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
