# Contradiction Detection and Resolution

> LLM-driven detection of conflicting facts and beliefs with DB-stored contradictions, interactive user resolution via buttons, and semantic similarity at 0.6 threshold for conflict discovery.

## Problem

A learning system that continuously absorbs facts from conversations, documents, and observations will inevitably accumulate contradictions. One fact says "Mike prefers dark roast coffee" while a newer one says "Mike switched to tea." Without detection and resolution, the system provides outdated or conflicting information -- eroding user trust. The challenge is twofold: detecting when new information actually contradicts existing knowledge (not just overlaps), and resolving conflicts in a way that respects the user's authority over their own data.

## Context

- An AI agent with a persistent fact/belief system that learns incrementally from interactions
- Facts are extracted automatically from conversations and stored with categories and confidence scores
- The system cannot simply overwrite old facts -- the old fact may still be valid in a different context
- Two subsystems handle contradictions: one for factual knowledge (learning/contradiction), one for personality beliefs (personality/beliefs/contradiction)
- Contradictions should be stored for user review rather than auto-resolved, since the system can't always determine which fact is correct

## Solution

### Two-Layer Contradiction Detection

Riley has two contradiction detection systems that operate on different knowledge types:

1. **Fact contradictions** (`lib/learning/contradiction.js`) -- Handles factual knowledge (preferences, personal info, project details). Uses LLM-driven analysis with semantic similarity.
2. **Belief contradictions** (`lib/personality/beliefs/contradiction.js`) -- Handles Riley's own behavioral beliefs. Uses heuristic-based detection with contradiction pairs.

### Semantic Similarity for Conflict Discovery

Potential conflicts are found using vector similarity search at a 0.6 threshold -- higher than the default search threshold to reduce false positives:

```javascript
// lib/learning/contradiction.js
async function findPotentialConflicts(newFact) {
  const vm = getVectorMemory();

  if (vm.isAvailable()) {
    const results = await vm.search(newFact.content, {
      sources: ['facts'],
      limit: 5,
      minScore: 0.6, // Higher threshold for potential conflicts
    });

    return results
      .filter((r) => r.id !== newFact.id)
      .map((r) => ({
        id: r.id,
        content: r.content,
        category: r.metadata?.category,
        confidence: r.metadata?.confidence,
        score: r.score,
      }));
  }

  // Fallback: category-based search with word overlap
  const sameCategoryFacts = await facts.getByCategory(newFact.category, 20);
  return sameCategoryFacts.filter((f) => {
    const newWords = newFact.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const existingWords = f.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const overlap = newWords.filter((w) => existingWords.includes(w));
    return overlap.length >= 2;
  });
}
```

### LLM-Driven Contradiction Analysis

Once candidate conflicts are found, an LLM determines whether a real contradiction exists and suggests a resolution:

```javascript
const CONTRADICTION_CHECK_PROMPT = `Given this NEW fact:
"{{newFact}}"

And these EXISTING facts that might be related:
{{existingFacts}}

Determine if the new fact contradicts any existing fact.

A contradiction means:
- The new fact directly conflicts with an existing fact (can't both be true)
- The new fact updates/changes information in an existing fact
- The new fact makes an existing fact obsolete

NOT a contradiction:
- Facts about different things that happen to be similar
- Complementary information
- More specific details that don't conflict

Return JSON:
{
  "hasContradiction": boolean,
  "contradictedFactId": number | null,
  "resolution": "supersede" | "merge" | "keep_both" | "reject_new",
  "reason": "brief explanation",
  "mergedContent": "if resolution is 'merge', provide the merged fact content" | null
}`;

async function checkSingle(newFact) {
  const potentialConflicts = await findPotentialConflicts(newFact);
  if (potentialConflicts.length === 0) return { hasContradiction: false };

  const result = await contradictionModel.generateContent(
    prompt.replace('{{newFact}}', newFact.content)
      .replace('{{existingFacts}}', potentialConflicts.map((f) => `[ID: ${f.id}] ${f.content}`).join('\n'))
  );

  return JSON.parse(result.response.text());
}
```

The LLM model is configured with `temperature: 0.1` and JSON response format to ensure deterministic, parseable output.

### DB-Stored Contradictions for User Review

Instead of auto-resolving, detected contradictions are stored in a `fact_contradictions` table with impact classification:

```javascript
async function storeContradiction(newFact, existingFact, contradictionResult) {
  // Determine impact based on category and confidence
  let impact = 'medium';
  if (newFact.category === 'preference' || existingFact?.category === 'preference') {
    impact = 'high'; // Preferences are important to get right
  } else if (newFact.confidence < 0.7) {
    impact = 'low';
  }

  const id = await insert('fact_contradictions', {
    new_fact_id: newFact.id,
    existing_fact_id: existingFact?.id || null,
    new_fact_content: newFact.content,
    existing_fact_content: existingFact?.content || '',
    suggested_resolution: resolution,
    merged_content: mergedContent || null,
    reason: reason || null,
    impact,
    status: 'pending',
  });

  return id;
}
```

### Interactive User Resolution via Buttons

Contradictions are surfaced to the user with actionable buttons through the messenger system:

```javascript
async function notifyContradiction(contradiction) {
  const msg = getMessenger();

  await msg.alert(
    'info',
    'Conflicting Information',
    `Previously: "${contradiction.existing_fact_content}"\n` +
    `Now: "${contradiction.new_fact_content}"\n\n` +
    `_Which one is correct?_`,
    { reason: contradiction.reason },
    [
      {
        label: 'Keep New',
        action: {
          type: 'socket',
          event: 'resolve_contradiction',
          payload: { id: contradiction.id, resolutionType: 'kept_new' },
        },
      },
      {
        label: 'Keep Old',
        action: {
          type: 'socket',
          event: 'resolve_contradiction',
          payload: { id: contradiction.id, resolutionType: 'kept_existing' },
        },
      },
      {
        label: 'Keep Both',
        action: {
          type: 'socket',
          event: 'resolve_contradiction',
          payload: { id: contradiction.id, resolutionType: 'kept_both' },
        },
      },
    ]
  );
}
```

### Resolution Execution

When the user clicks a button, the resolution is applied to the fact store:

```javascript
async function userResolveContradiction(contradictionId, resolutionType, options = {}) {
  const contradiction = await select('fact_contradictions').where('id = ?', contradictionId).one();

  switch (resolutionType) {
    case 'kept_new':
      // Supersede old fact with new
      if (contradiction.existing_fact_id) {
        await facts.supersede(contradiction.existing_fact_id, contradiction.new_fact_content);
      }
      break;

    case 'kept_existing':
      // No fact changes -- just mark resolved
      break;

    case 'kept_both':
      // No fact changes needed
      break;

    case 'merged_custom':
      // Create merged fact, supersede both
      if (options.mergedContent && contradiction.existing_fact_id) {
        await facts.supersede(contradiction.existing_fact_id, options.mergedContent);
      }
      break;

    case 'accepted_suggestion':
      // Apply the AI's suggested resolution
      return userResolveContradiction(contradictionId, contradiction.suggested_resolution, {
        mergedContent: contradiction.merged_content,
      });
  }

  await update('fact_contradictions', {
    status: 'resolved',
    resolved_at: new Date().toISOString(),
    resolution_type: resolutionType,
  }, 'id = ?', contradictionId);
}
```

### Heuristic Belief Contradiction Detection

The belief system uses a lighter-weight approach with predefined contradiction pairs and stance extraction:

```javascript
// lib/personality/beliefs/constants.js
const CONTRADICTION_PAIRS = [
  ['always', 'never'],
  ['more', 'less'],
  ['should', "shouldn't"],
  ['quick', 'thorough'],
  ['brief', 'detailed'],
  ['proactive', 'wait'],
];

// lib/personality/beliefs/contradiction.js
async function findContradictions(newBeliefText) {
  const id = await identity.getIdentity();
  const contradictions = [];

  for (const existing of id.beliefs) {
    let conflictScore = 0;

    // Check contradiction pairs (0.3 per match)
    for (const [wordA, wordB] of CONTRADICTION_PAIRS) {
      if ((newHas(wordA) && existingHas(wordB)) || (newHas(wordB) && existingHas(wordA))) {
        conflictScore += 0.3;
      }
    }

    // Same topic, different stance (0.4)
    if (topicOverlap > 0.3) {
      const newStance = extractStance(newText);
      const existingStance = extractStance(existingText);
      if (newStance && existingStance && newStance !== existingStance) {
        conflictScore += 0.4;
      }
    }

    // Strong conflicts (>0.5) are flagged for resolution
    // Weak conflicts (0.2-0.5) weaken the old belief slightly
    if (conflictScore > 0.2) {
      contradictions.push({ belief: existing.belief, conflictScore });
    }
  }

  return contradictions;
}
```

## Implications

- LLM-driven analysis (not majority voting) catches nuanced contradictions that simple text comparison would miss -- "prefers tea" vs. "loves dark roast" requires understanding, not word matching
- The 0.6 similarity threshold is deliberately higher than the default search threshold (typically 0.3-0.4), reducing false positive conflict detection at the cost of potentially missing loosely-related contradictions
- Storing contradictions for user review preserves user agency -- the system surfaces conflicts but never silently resolves them, which matters especially for preferences
- Impact classification (high for preferences, low for low-confidence facts) helps users triage -- they can focus on high-impact contradictions first
- Interactive buttons (Keep New / Keep Old / Keep Both) provide single-tap resolution through the chat interface, reducing friction
- The dual system (LLM for facts, heuristics for beliefs) reflects different accuracy needs -- facts need semantic understanding, while beliefs benefit from fast rule-based detection
- Resolution tracking (`trackResolution`) logs whether users follow AI suggestions, enabling future improvement of suggestion quality
- Contradictions can also be dismissed without resolution, preventing the queue from growing indefinitely with edge cases

## Code Example

```javascript
const factContradiction = require('./lib/learning/contradiction');

// Check new facts for contradictions
const newFacts = [{ id: 42, content: 'Mike prefers green tea', category: 'preference' }];
const contradictions = await factContradiction.checkAll(newFacts);
// → [{ factId: 42, hasContradiction: true, contradictedFactId: 15,
//      resolution: 'supersede', reason: 'Updates beverage preference' }]

// Get unresolved contradictions
const pending = await factContradiction.getUnresolvedContradictions({ impact: 'high' });
// → [{ id: 7, new_fact_content: 'Mike prefers green tea',
//      existing_fact_content: 'Mike loves dark roast coffee',
//      suggested_resolution: 'supersede', impact: 'high' }]

// Get stats
const stats = await factContradiction.getContradictionStats();
// → { total: 3, high: 1, medium: 1, low: 1 }

// User resolves via button click
await factContradiction.userResolveContradiction(7, 'kept_new');
```

## Related Patterns

- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
