# Autonomy Rule Suggestion

> AI-driven suggestion of user-defined automation rules based on observed behavioral patterns — the system learns what it should be allowed to do.

## Problem

Configuring an AI agent's autonomy is tedious. Users must manually define rules like "auto-approve task creation for project X" or "always ask before sending messages to clients." Most users don't know what rules they need until they've been interrupted by approval requests dozens of times. The ideal system would observe the user's approval patterns and suggest rules that match their demonstrated preferences — turning reactive permission management into proactive automation.

## Context

- An AI agent with autonomy tiers (AUTO/NOTIFY/ASK/NEVER) that gate different actions
- Users frequently approve or deny the same types of actions
- Approval patterns are contextual: auto-approve for personal projects but always ask for client work
- The system has access to historical approval decisions with metadata (action type, target, time, decision)
- Suggested rules must be human-readable and editable — not opaque ML decisions

## Solution

A rule suggestion engine analyzes historical approval decisions to detect patterns. When a pattern reaches sufficient confidence (consistent decisions over multiple occurrences), the system suggests a named automation rule. The user can accept, modify, or reject the suggestion. Accepted rules are stored as first-class autonomy rules that gate future actions.

### Pattern Detection

The engine aggregates approval decisions by action type and contextual dimensions:

```javascript
// tools/suggest-autonomy-rule.js — illustrative
async function analyzeApprovalPatterns(decisions) {
  // Group decisions by action type + context dimensions
  const patterns = {};

  for (const decision of decisions) {
    const key = buildPatternKey(decision);

    if (!patterns[key]) {
      patterns[key] = { approved: 0, denied: 0, contexts: [], lastSeen: null };
    }

    if (decision.approved) {
      patterns[key].approved++;
    } else {
      patterns[key].denied++;
    }
    patterns[key].contexts.push(decision.context);
    patterns[key].lastSeen = decision.timestamp;
  }

  return patterns;
}

function buildPatternKey(decision) {
  // Group by: action type + significant context dimensions
  const parts = [decision.actionType];

  if (decision.context.project) parts.push(`project:${decision.context.project}`);
  if (decision.context.targetType) parts.push(`target:${decision.context.targetType}`);
  if (decision.context.source) parts.push(`source:${decision.context.source}`);

  return parts.join('|');
}
```

### Confidence Scoring

A pattern becomes suggestion-worthy when it shows consistent behavior over enough occurrences:

```javascript
function scoreSuggestion(pattern) {
  const total = pattern.approved + pattern.denied;
  if (total < 5) return 0; // Need minimum sample size

  const consistency = Math.max(pattern.approved, pattern.denied) / total;
  const recency = daysSince(pattern.lastSeen) < 7 ? 1.0 : 0.8;

  return consistency * recency;
}

const SUGGESTION_THRESHOLD = 0.85;

function generateSuggestions(patterns) {
  return Object.entries(patterns)
    .map(([key, pattern]) => ({
      key,
      pattern,
      score: scoreSuggestion(pattern),
      direction: pattern.approved > pattern.denied ? 'AUTO' : 'NEVER',
    }))
    .filter(s => s.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}
```

### Rule Generation

Suggestions are converted to human-readable rule definitions:

```javascript
// lib/agent/autonomy-rules.js — illustrative
function suggestionToRule(suggestion) {
  const { key, direction, pattern } = suggestion;
  const dimensions = parsePatternKey(key);

  return {
    name: generateRuleName(dimensions),
    description: generateDescription(dimensions, direction, pattern),
    conditions: {
      actionType: dimensions.actionType,
      project: dimensions.project ?? undefined,
      targetType: dimensions.targetType ?? undefined,
      source: dimensions.source ?? undefined,
    },
    autonomyTier: direction,  // AUTO or NEVER
    confidence: suggestion.score,
    basedOn: pattern.approved + pattern.denied, // Number of observations
  };
}

function generateRuleName(dimensions) {
  const parts = [`auto-${dimensions.actionType}`];
  if (dimensions.project) parts.push(`for-${dimensions.project}`);
  if (dimensions.targetType) parts.push(`on-${dimensions.targetType}`);
  return parts.join('-');
}

function generateDescription(dimensions, direction, pattern) {
  const action = direction === 'AUTO' ? 'Auto-approve' : 'Always ask before';
  const scope = dimensions.project ? ` in ${dimensions.project}` : '';
  return `${action} ${dimensions.actionType}${scope} (based on ${pattern.approved + pattern.denied} past decisions)`;
}
```

### User-Facing Suggestion Flow

Suggestions are surfaced through the attention system and require explicit acceptance:

```javascript
async function proposeSuggestions() {
  const decisions = await getRecentDecisions({ days: 30 });
  const patterns = await analyzeApprovalPatterns(decisions);
  const suggestions = generateSuggestions(patterns);

  for (const suggestion of suggestions) {
    const rule = suggestionToRule(suggestion);

    // Surface as an attention item, not auto-applied
    await addAttentionItem({
      source: 'autonomy',
      title: `Suggested rule: ${rule.name}`,
      body: `${rule.description}. Accept this rule?`,
      urgency: 'low',
      metadata: { rule, suggestion },
    });
  }
}

async function acceptSuggestion(suggestionId) {
  const rule = getSuggestion(suggestionId).rule;
  await saveAutonomyRule(rule);
  logger.info('Autonomy rule accepted', { name: rule.name, tier: rule.autonomyTier });
}
```

## Implications

- Shifts autonomy configuration from manual to semi-automatic — reduces friction while keeping the user in control
- The 5-observation minimum and 0.85 confidence threshold prevent premature suggestions from noisy data
- Rules are transparent and editable — unlike opaque ML models, users can understand and modify suggested rules
- Pattern detection is dimension-based (project, target type, source) — adding new dimensions requires updating the key builder
- Suggestions are never auto-applied — the attention item flow ensures the user consciously opts in
- Historical decisions may not reflect current preferences — recency weighting helps but a "reset" mechanism would be useful for preference changes
- The system learns what it should be allowed to do, creating a natural path from cautious (ASK everything) to confident (AUTO where appropriate)

## Code Example

```javascript
// User has approved 12 task creations in "website-redesign" project, denied 0
// Pattern: { key: 'create-task|project:website-redesign', approved: 12, denied: 0 }
// Score: 1.0 (100% consistency, recent)

// System suggests:
// {
//   name: 'auto-create-task-for-website-redesign',
//   description: 'Auto-approve create-task in website-redesign (based on 12 past decisions)',
//   conditions: { actionType: 'create-task', project: 'website-redesign' },
//   autonomyTier: 'AUTO',
// }

// User accepts → future task creations in that project skip approval
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
