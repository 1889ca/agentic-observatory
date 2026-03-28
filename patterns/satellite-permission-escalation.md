# Worker Permission Escalation

> Confidence-scored permission decisions where numeric tool tiers (1-4) combine with user autonomy level and runtime confidence signals to produce an effective score that determines execute, notify, or queue behavior.

## Problem

When a worker agent needs to perform an action, the system needs a permission model that balances safety with usability. A purely static model (each tool always behaves the same way) ignores context: sending an email during work hours after recent successes is different from sending one at 2 AM after a string of failures. But a purely dynamic model is unpredictable and hard to audit. The system needs a hybrid: static tiers as the foundation, runtime confidence as the multiplier, and clear thresholds that map to deterministic outcomes.

## Context

- Workers executing tool calls with varying levels of risk and reversibility
- Tools classified into 4 numeric tiers (AUTO=1, NOTIFY=2, ASK=3, NEVER=4) via a static tier registry
- A user-configurable autonomy level (1-4) that represents how much freedom the agent has
- Runtime signals (historical success rate, parameter completeness, context alignment, recency, time-of-day) that modify confidence per tool call
- Decisions must be recorded for learning and threshold tuning

## Solution

### Numeric Tier Foundation

Every tool is statically assigned a tier in `lib/tools/tiers.js`. The tier reflects the tool's inherent risk level:

```javascript
// lib/tools/tiers.js
const TOOL_TIERS = {
  // AUTO (1) — safe read-only operations
  list_todos: APPROVAL_TIERS.AUTO,
  search_emails: APPROVAL_TIERS.AUTO,
  check_calendar: APPROVAL_TIERS.AUTO,

  // NOTIFY (2) — internal modifications
  add_todo: APPROVAL_TIERS.NOTIFY,
  save_note: APPROVAL_TIERS.NOTIFY,
  create_event: APPROVAL_TIERS.NOTIFY,

  // ASK (3) — external actions
  send_email: APPROVAL_TIERS.ASK,
  solve_issue: APPROVAL_TIERS.ASK,
  whatsapp_send: APPROVAL_TIERS.ASK,

  // NEVER (4) — destructive/irreversible
  delete_project: APPROVAL_TIERS.NEVER,
  github_merge_pr: APPROVAL_TIERS.NEVER,
  set_autonomy_level: APPROVAL_TIERS.NEVER,
};

// Unknown tools default to NOTIFY (safe middle ground)
function getToolTier(toolName) {
  return TOOL_TIERS[normalized] ?? APPROVAL_TIERS.NOTIFY;
}
```

### Confidence Scoring

The confidence engine in `lib/agent/confidence.js` calculates a runtime confidence score (0-1.5) from 5 weighted signals:

```javascript
// lib/agent/confidence.js
const SIGNAL_WEIGHTS = {
  toolSuccessRate: 0.30,        // Historical success/failure ratio
  parameterCompleteness: 0.20,  // Are required params provided?
  contextAlignment: 0.20,       // Does active context support this tool?
  recentSuccess: 0.15,          // Has this tool succeeded recently?
  timeOfDay: 0.15,              // Work hours vs off-hours
};

async function calculateConfidence(toolName, args, context) {
  const signals = {};
  signals.toolSuccessRate = await getToolSuccessRate(toolName);
  signals.parameterCompleteness = await validateParameters(toolName, args);
  signals.contextAlignment = await getContextAlignment(toolName);
  signals.recentSuccess = await getRecentSuccessBonus(toolName);
  signals.timeOfDay = getTimeOfDayFactor();

  let score = 0;
  for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    score += (signals[signal] ?? 0.5) * weight;
  }

  return { score: Math.max(0, Math.min(1.5, score)), signals, explanation };
}
```

Context alignment uses affinity maps: during a `deep_work` context, `save_note` gets a boost while `send_email` gets a reduction. Time-of-day scoring reduces confidence on weekends and off-hours.

### The Decision Engine

`lib/agent/confidence-decision.js` combines the static tier, the user's autonomy level, and the runtime confidence score into a single effective score that maps to a decision:

```javascript
// lib/agent/confidence-decision.js

// Base score matrix: [tier] × [autonomy level 1-4]
const BASE_TIER_SCORES = {
  [APPROVAL_TIERS.AUTO]:   [1.0, 1.0, 1.0, 1.0],  // Always high base
  [APPROVAL_TIERS.NOTIFY]: [0.3, 1.0, 1.0, 1.0],  // Needs autonomy 2+
  [APPROVAL_TIERS.ASK]:    [0.0, 0.4, 1.0, 1.0],  // Needs autonomy 3+
  [APPROVAL_TIERS.NEVER]:  [0.0, 0.0, 0.0, 0.6],  // Always low, even at 4
};

const THRESHOLDS = {
  execute: 0.85,  // Auto-execute
  notify: 0.60,   // Execute with notification
  queue: 0.40,    // Queue for approval
  // Below 0.40: queue with low-confidence warning
};

async function makeDecision(toolName, args, sessionId, options) {
  const tier = toolTiers.getToolTier(toolName);
  const autonomy = await agentSettings.getAutonomyLevel();
  const confidence = await calculateConfidence(toolName, args, { sessionId });

  // Base score from tier x autonomy matrix
  const baseScore = BASE_TIER_SCORES[tier][autonomy - 1] ?? 0.5;

  // Effective score = base * confidence
  let effectiveScore = baseScore * confidence.score;

  // User-requested actions bypass scoring (except NEVER)
  if (options.userRequested && tier !== APPROVAL_TIERS.NEVER) {
    effectiveScore = Math.max(effectiveScore, THRESHOLDS.execute + 0.01);
  }

  // Map to decision
  if (tier === APPROVAL_TIERS.NEVER) return { decision: 'queue', ... };
  if (effectiveScore >= THRESHOLDS.execute) return { decision: 'execute', ... };
  if (effectiveScore >= THRESHOLDS.notify) return { decision: 'notify', ... };
  return { decision: 'queue', ... };
}
```

### How the Matrix Works

The base score matrix encodes the relationship between tool risk and user trust:

| Tier | Autonomy 1 | Autonomy 2 | Autonomy 3 | Autonomy 4 |
|------|-----------|-----------|-----------|-----------|
| AUTO (1) | 1.0 | 1.0 | 1.0 | 1.0 |
| NOTIFY (2) | 0.3 | 1.0 | 1.0 | 1.0 |
| ASK (3) | 0.0 | 0.4 | 1.0 | 1.0 |
| NEVER (4) | 0.0 | 0.0 | 0.0 | 0.6 |

A NOTIFY tool at autonomy 1 gets base 0.3. Multiplied by a confidence of 0.9 gives an effective score of 0.27 -- below the queue threshold, so it gets queued. The same tool at autonomy 2 gets base 1.0 * 0.9 = 0.9, which exceeds the execute threshold.

### Decision Recording and Learning

Every decision is persisted to `confidence_decisions` for analysis and threshold tuning:

```javascript
await insert('confidence_decisions', {
  tool_name: toolName,
  tier: decision.tier,
  autonomy_level: decision.autonomy,
  confidence_score: decision.confidence.score,
  effective_score: decision.effectiveScore,
  decision: decision.decision,
  signals: JSON.stringify(decision.confidence.signals),
  session_id: sessionId,
});
```

The system can later analyze decision accuracy and suggest threshold adjustments based on false positives (executed but failed) and false negatives (queued but would have been approved).

## Implications

- The tier is static but the decision is dynamic: the same ASK-tier tool can auto-execute at autonomy 3 with high confidence but queue at autonomy 2 with low confidence
- NEVER tier is a hard boundary: even at autonomy 4 with maximum confidence, the base score is 0.6, which only reaches the notify band -- NEVER tools always queue
- User-requested actions short-circuit the scoring (except NEVER): when the user says "send this email," that IS the approval -- the system pushes the effective score above the execute threshold
- Confidence signals are eventually consistent: `toolSuccessRate` needs 3+ executions before it leaves neutral (0.5), so new tools start in a conservative posture
- Off-hours and weekend scoring reduces confidence globally, making the system more cautious outside work hours
- The decision log enables a feedback loop: `suggestThresholdAdjustments()` queries for patterns of executed-but-failed and queued-but-approved to recommend threshold changes
- Five signals with fixed weights means no single signal can dominate: even a perfect success rate (0.30 contribution) cannot overcome a 0.0 base score for an ASK tool at autonomy 1

## Code Example

```javascript
// Tool: send_email (ASK tier = 3)
// User autonomy: 2
// Confidence: 0.85 (high success rate, all params, work hours)

// Base score: BASE_TIER_SCORES[ASK][autonomy 2 - 1] = 0.4
// Effective: 0.4 * 0.85 = 0.34
// Decision: queue (below 0.40 threshold)

// Same tool, autonomy 3:
// Base score: BASE_TIER_SCORES[ASK][autonomy 3 - 1] = 1.0
// Effective: 1.0 * 0.85 = 0.85
// Decision: execute (at threshold)

// Same tool, user-requested at any autonomy:
// Effective: max(computed, 0.86) = 0.86
// Decision: execute (user request overrides)

// Tool: delete_project (NEVER tier = 4)
// User autonomy: 4, confidence: 1.0
// Base score: BASE_TIER_SCORES[NEVER][3] = 0.6
// Effective: 0.6 * 1.0 = 0.6
// Decision: queue (NEVER always queues, confidence only affects priority)
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
