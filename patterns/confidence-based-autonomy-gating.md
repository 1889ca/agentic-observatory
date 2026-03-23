# Confidence-Based Autonomy Gating

> Multi-signal weighted confidence scoring where five distinct signals — tool success rate, parameter completeness, context alignment, recent performance, and time-of-day patterns — combine with fixed weights and post-calculation adjustments to produce a 0-1 confidence score that modulates autonomy tiers.

## Problem

Fixed autonomy levels are too rigid. An agent that always asks for permission is annoying; one that never does is dangerous. The right level of autonomy depends on the agent's track record — but a single success/failure ratio is too simplistic. A tool call can "succeed" while being contextually wrong, or fail because of bad parameter mapping rather than bad judgment. The confidence system needs to decompose performance into meaningful signals to build accurate trust.

## Context

- An autonomous agent making decisions with varying risk levels across different capability domains
- Complementary to static decision-gating tiers (AUTO/NOTIFY/ASK/NEVER), which control notification routing. This pattern controls whether the agent's confidence justifies bypassing approval.
- A single metric (success rate) misses important dimensions — an agent might succeed often but with sloppy parameters, or succeed in the wrong context
- Recent performance should matter more than ancient history, but not so much that a single failure tanks confidence
- Specific conditions (recent streaks, recent failures) should nudge the score up or down after the base calculation

## Solution

### Multi-Signal Weighted Scoring

Confidence scores are computed from five weighted signals rather than a simple success ratio. Each signal captures a different dimension of agent reliability:

| Signal | Weight | Description |
|---|---|---|
| `toolSuccessRate` | 0.30 | Ratio of successful tool executions to total attempts |
| `parameterCompleteness` | 0.20 | How well the agent fills in required and optional parameters |
| `contextAlignment` | 0.20 | How well the action fits the current conversation context |
| `recentSuccess` | 0.15 | Short-window success rate (last N actions), so recent performance carries extra weight |
| `timeOfDay` | 0.15 | Confidence adjustment based on time-of-day usage patterns |

The composite score is a weighted sum, clamped to [0, 1]:

```javascript
function computeConfidence(signals) {
  const weights = {
    toolSuccessRate: 0.30,
    parameterCompleteness: 0.20,
    contextAlignment: 0.20,
    recentSuccess: 0.15,
    timeOfDay: 0.15,
  };

  let score = 0;
  for (const [signal, weight] of Object.entries(weights)) {
    score += (signals[signal] ?? 0) * weight;
  }

  return Math.max(0, Math.min(1, score));
}
```

### Signal Collection

Each signal is computed independently:

```javascript
// toolSuccessRate: cumulative success ratio
// signals.toolSuccessRate = successfulExecutions / totalExecutions

// parameterCompleteness: average fill rate across recent calls
// signals.parameterCompleteness = filledParams / totalExpectedParams

// contextAlignment: semantic similarity between action and conversation context
// signals.contextAlignment = cosineSimilarity(actionEmbedding, contextEmbedding)

// recentSuccess: windowed success rate (e.g., last 20 actions)
// signals.recentSuccess = recentSuccesses / recentWindow

// timeOfDay: learned confidence modifier from historical time-of-day patterns
// signals.timeOfDay = timeOfDayModel.predict(currentHour)
```

### Post-Calculation Adjustments

After computing the base weighted score, additive and subtractive adjustments are applied based on specific conditions. This is simpler than per-domain weight redistribution — the five signal weights are always fixed, and situational nudges shift the final score:

```javascript
function computeConfidence(signals, conditions = {}) {
  const weights = {
    toolSuccessRate: 0.30,
    parameterCompleteness: 0.20,
    contextAlignment: 0.20,
    recentSuccess: 0.15,
    timeOfDay: 0.15,
  };

  let score = 0;
  for (const [signal, weight] of Object.entries(weights)) {
    score += (signals[signal] ?? 0) * weight;
  }

  // Post-calculation adjustments based on specific conditions
  if (conditions.recentStreak)    score += 0.10;  // Consistent recent success
  if (conditions.recentFailure)   score -= 0.15;  // Recent tool failure
  if (conditions.highComplexity)  score -= 0.10;  // Complex multi-step action
  if (conditions.userOverride)    score += 0.20;  // User explicitly trusts

  return Math.max(0, Math.min(1, score));
}
```

The adjustments are additive/subtractive — they shift the score after the weighted sum rather than changing the weights themselves. The final result is always clamped to [0, 1].

### Autonomy Integration

The composite confidence score feeds into the autonomy decision at tool execution time:

```javascript
async function executeToolWithAutonomy(toolName, args, userId, options = {}) {
  const tool = registry.get(toolName);
  const domain = tool.domain || 'general';
  const signals = await confidence.getSignals(userId, domain);
  const conditions = await confidence.getConditions(userId, domain);
  const score = computeConfidence(signals, conditions);

  // High confidence + AUTO tier -> execute without asking
  if (tool.autonomyTier === 'AUTO' || (tool.autonomyTier === 'NOTIFY' && score > 0.8)) {
    const result = await tool.execute(args);
    confidence.recordOutcome(userId, domain, { success: true, args }).catch(() => {});
    return result;
  }

  // Low confidence or ASK tier -> require approval
  if (tool.autonomyTier === 'ASK' || score < 0.3) {
    return await requestApproval(userId, toolName, args);
  }

  // Middle ground: execute and notify
  const result = await tool.execute(args);
  await notify(userId, `Executed ${toolName}`, result);
  confidence.recordOutcome(userId, domain, { success: true, args }).catch(() => {});
  return result;
}
```

### Fire-and-Forget Signal Recording

Outcome recording updates all five signal stores asynchronously to avoid blocking the response path:

```javascript
async function recordOutcome(userId, domain, outcome) {
  // Update toolSuccessRate (cumulative)
  await updateSuccessRate(userId, domain, outcome.success);

  // Update parameterCompleteness (from args vs schema)
  const completeness = computeParamCompleteness(outcome.args, domain);
  await updateParamScore(userId, domain, completeness);

  // Update recentSuccess (sliding window)
  await pushToRecentWindow(userId, domain, outcome.success);

  // contextAlignment and timeOfDay are computed at read time, not stored
}
```

## Implications

- Five signals provide a much richer trust model than a single success ratio — the system can distinguish between "succeeds but sloppy" and "precise but context-blind"
- Fixed weights keep the scoring model simple and predictable — no per-domain weight tuning needed
- Post-calculation adjustments allow situational nudges (recent streaks, failures, complexity) without complicating the base formula
- `recentSuccess` (0.15) provides recency bias without discarding history — a bad week matters, but not forever
- `timeOfDay` (0.15) captures real usage patterns — agents that run well-tested daytime workflows but struggle with overnight batch jobs get appropriately gated
- `parameterCompleteness` (0.20) catches a common failure mode where agents call the right tool but with incomplete or default parameters
- Fire-and-forget recording means confidence tracking never adds latency to tool execution
- This pattern complements static tiers (AUTO/NOTIFY/ASK/NEVER) — tiers set the baseline, confidence fine-tunes within the tier's range

## Code Example

```javascript
// Complete confidence lifecycle:
// 1. Agent prepares to execute a tool
const signals = await confidence.getSignals(userId, 'code_review');
// => { toolSuccessRate: 0.92, parameterCompleteness: 0.85,
//      contextAlignment: 0.78, recentSuccess: 0.90, timeOfDay: 0.88 }

const conditions = await confidence.getConditions(userId, 'code_review');
// => { recentStreak: true, recentFailure: false, highComplexity: false }

const score = computeConfidence(signals, conditions);
// => Base: 0.92*0.30 + 0.85*0.20 + 0.78*0.20 + 0.90*0.15 + 0.88*0.15
//    = 0.276 + 0.170 + 0.156 + 0.135 + 0.132 = 0.869
//    + recentStreak adjustment: +0.10 → 0.969 (clamped to 1.0 max)
// => Score > 0.8, NOTIFY-tier tool auto-executes

// 2. Tool executes, outcome recorded (fire-and-forget)
// confidence.recordOutcome(userId, 'code_review', { success: true, args })

// 3. Hours later, PR outcome observed via webhook
// events.emit('github.pr_merged', { tenantId: userId, pr: { ... } })
// => Updates toolSuccessRate and recentSuccess for 'code_review'

// 4. After consistent success, confidence stays above 0.8
// => Future PR-related tools auto-execute even if their tier is 'NOTIFY'

// 5. A tool failure occurs
// => recentFailure condition activates (-0.15 adjustment)
// => Combined with parameterCompleteness drop, score falls below 0.8
// => Future actions require notification again
```

## Relationship to Other Autonomy Patterns

This pattern sits alongside [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md) in the autonomy system:

- **Decision Gating** sets the static baseline (AUTO/NOTIFY/ASK per decision type)
- **Confidence-Based Gating (this pattern)** modulates that baseline using multi-signal weighted scoring — a NOTIFY-tier action with high composite confidence (>0.8) can auto-execute

**Note:** Confidence scoring and the vibe/anticipation system are two separate systems that coexist but are not integrated. The confidence score feeds autonomy gating independently — it does not interact with the anticipation engine or vibe detection. They run in parallel without cross-feeding signals.

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Deliberative Alignment](./deliberative-alignment.md)
- [Anticipation Engine](./anticipation-engine.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
