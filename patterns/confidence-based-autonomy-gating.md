# Confidence-Based Autonomy Gating

> Multi-signal weighted confidence scoring with context affinities, where five distinct signals — tool success rate, parameter completeness, context alignment, recent performance, and time-of-day patterns — combine to produce a 0-1 confidence score that modulates autonomy tiers.

## Problem

Fixed autonomy levels are too rigid. An agent that always asks for permission is annoying; one that never does is dangerous. The right level of autonomy depends on the agent's track record — but a single success/failure ratio is too simplistic. A tool call can "succeed" while being contextually wrong, or fail because of bad parameter mapping rather than bad judgment. The confidence system needs to decompose performance into meaningful signals to build accurate trust.

## Context

- An autonomous agent making decisions with varying risk levels across different capability domains
- Complementary to static decision-gating tiers (AUTO/NOTIFY/ASK/NEVER), which control notification routing. This pattern controls whether the agent's confidence justifies bypassing approval.
- A single metric (success rate) misses important dimensions — an agent might succeed often but with sloppy parameters, or succeed in the wrong context
- Different contexts should weight signals differently — parameter completeness matters more for API calls than for chat responses
- Recent performance should matter more than ancient history, but not so much that a single failure tanks confidence

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

### Context Affinities

Not all signals matter equally in every context. Context affinities let the system reweight signals based on the domain of the action:

```javascript
const contextAffinities = {
  api_calls: {
    toolSuccessRate: 0.25,
    parameterCompleteness: 0.35, // params matter more for API calls
    contextAlignment: 0.15,
    recentSuccess: 0.15,
    timeOfDay: 0.10,
  },
  code_review: {
    toolSuccessRate: 0.25,
    parameterCompleteness: 0.10,
    contextAlignment: 0.35, // context matters more for reviews
    recentSuccess: 0.15,
    timeOfDay: 0.15,
  },
  scheduling: {
    toolSuccessRate: 0.20,
    parameterCompleteness: 0.15,
    contextAlignment: 0.15,
    recentSuccess: 0.15,
    timeOfDay: 0.35, // time-of-day patterns dominate scheduling
  },
};

function computeConfidence(signals, context) {
  const weights = contextAffinities[context] ?? {
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

Context affinities always sum to 1.0 — they redistribute weight, they don't add it. The default weights apply when no specific affinity is defined for a context.

### Autonomy Integration

The composite confidence score feeds into the autonomy decision at tool execution time:

```javascript
async function executeToolWithAutonomy(toolName, args, userId, options = {}) {
  const tool = registry.get(toolName);
  const domain = tool.domain || 'general';
  const signals = await confidence.getSignals(userId, domain);
  const score = computeConfidence(signals, domain);

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
- Context affinities mean the same agent can have different effective confidence in different domains without maintaining separate score histories
- `recentSuccess` (0.15) provides recency bias without discarding history — a bad week matters, but not forever
- `timeOfDay` (0.15) captures real usage patterns — agents that run well-tested daytime workflows but struggle with overnight batch jobs get appropriately gated
- `parameterCompleteness` (0.20) catches a common failure mode where agents call the right tool but with incomplete or default parameters
- Fire-and-forget recording means confidence tracking never adds latency to tool execution
- Context affinities must sum to 1.0 — adding a new signal requires rebalancing all affinity profiles
- This pattern complements static tiers (AUTO/NOTIFY/ASK/NEVER) — tiers set the baseline, confidence fine-tunes within the tier's range

## Code Example

```javascript
// Complete confidence lifecycle:
// 1. Agent prepares to execute a tool
const signals = await confidence.getSignals(userId, 'code_review');
// => { toolSuccessRate: 0.92, parameterCompleteness: 0.85,
//      contextAlignment: 0.78, recentSuccess: 0.90, timeOfDay: 0.88 }

const score = computeConfidence(signals, 'code_review');
// => With code_review affinities:
//    0.92*0.25 + 0.85*0.10 + 0.78*0.35 + 0.90*0.15 + 0.88*0.15
//    = 0.23 + 0.085 + 0.273 + 0.135 + 0.132 = 0.855
// => Score > 0.8, NOTIFY-tier tool auto-executes

// 2. Tool executes, outcome recorded (fire-and-forget)
// confidence.recordOutcome(userId, 'code_review', { success: true, args })

// 3. Hours later, PR outcome observed via webhook
// events.emit('github.pr_merged', { tenantId: userId, pr: { ... } })
// => Updates toolSuccessRate and recentSuccess for 'code_review'

// 4. After consistent success, confidence stays above 0.8
// => Future PR-related tools auto-execute even if their tier is 'NOTIFY'

// 5. A string of parameter issues (incomplete PR descriptions)
// => parameterCompleteness drops, pulling composite score below 0.8
// => Future PRs require notification again, even though success rate is fine
```

## Relationship to Other Autonomy Patterns

This pattern sits between [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md) and [Deliberative Alignment](./deliberative-alignment.md) in the autonomy stack:

- **Decision Gating** sets the static baseline (AUTO/NOTIFY/ASK per decision type)
- **Confidence-Based Gating (this pattern)** modulates that baseline using multi-signal weighted scoring — a NOTIFY-tier action with high composite confidence (>0.8) can auto-execute
- **Deliberative Alignment** resolves ambiguity when confidence lands in the notify band (0.60-0.85) via multi-model voting

The confidence score from this pattern is the input signal that triggers deliberative alignment. Without it, the system has no continuous measure of trust.

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Deliberative Alignment](./deliberative-alignment.md)
- [Anticipation Engine](./anticipation-engine.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
