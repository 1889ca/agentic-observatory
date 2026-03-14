# Confidence-Based Autonomy Gating

> Dynamically adjust agent autonomy based on accumulated confidence scores per operation type, earning independence through successful track record.

## Problem

Fixed autonomy levels are too rigid. An agent that always asks for permission is annoying; one that never does is dangerous. The right level of autonomy depends on the agent's track record with a specific type of operation. A fresh deployment should be cautious everywhere, but after dozens of successful git commits, the agent shouldn't still be asking "may I commit?" every time. Conversely, a single bad deployment should immediately tighten the leash on deploy operations, even if the agent has been doing well with everything else.

## Context

- An autonomous agent making decisions with varying risk levels across different operation categories
- Complementary to static decision-gating tiers, which control notification routing. This pattern controls whether gating is bypassed entirely.
- The agent operates over extended periods where its competence at specific tasks can be observed and measured
- Different operation types carry different risk profiles and should be tracked independently

## Solution

### Confidence Tracking

Each operation type maintains an independent confidence score between 0.0 and 1.0. Scores start low, reflecting the principle that autonomy must be earned:

```javascript
class ConfidenceTracker {
  constructor(options = {}) {
    this.scores = new Map();
    this.defaults = {
      initial: options.initial ?? 0.2,
      successIncrement: options.successIncrement ?? 0.05,
      failureDecrement: options.failureDecrement ?? 0.15,
      autonomyThreshold: options.autonomyThreshold ?? 0.7,
      decayRate: options.decayRate ?? 0.01,
      decayIntervalMs: options.decayIntervalMs ?? 24 * 60 * 60 * 1000,
    };
  }

  getScore(operationType) {
    if (!this.scores.has(operationType)) {
      this.scores.set(operationType, {
        value: this.defaults.initial,
        lastUpdated: Date.now(),
        successes: 0,
        failures: 0,
      });
    }
    return this.scores.get(operationType);
  }
}
```

### Success and Failure Feedback

After each operation, the system records whether it succeeded or failed. The update is asymmetric: failures decrease confidence by a larger amount than successes increase it, biasing the system toward caution:

```javascript
recordSuccess(operationType) {
  const score = this.getScore(operationType);
  score.value = Math.min(1.0, score.value + this.defaults.successIncrement);
  score.lastUpdated = Date.now();
  score.successes++;
}

recordFailure(operationType) {
  const score = this.getScore(operationType);
  score.value = Math.max(0.0, score.value - this.defaults.failureDecrement);
  score.lastUpdated = Date.now();
  score.failures++;
}
```

With the default settings (success +0.05, failure -0.15), a single failure cancels three successes. Starting from 0.2, the agent needs 10 consecutive successes to cross the 0.7 autonomy threshold — but a single failure drops it back below.

### Autonomy Boost

When confidence for an operation type exceeds the threshold, the agent can execute without human approval. Below the threshold, it must request confirmation:

```javascript
canActAutonomously(operationType) {
  const score = this.getScore(operationType);
  this.applyDecay(score);
  return score.value >= this.defaults.autonomyThreshold;
}

async executeOrAsk(operationType, action, askHuman) {
  if (this.canActAutonomously(operationType)) {
    return action();
  }
  return askHuman(operationType, action);
}
```

### Score Decay

Confidence decays over time when an operation type isn't exercised. This prevents stale high-confidence scores from granting autonomy on operations the agent hasn't performed recently:

```javascript
applyDecay(score) {
  const elapsed = Date.now() - score.lastUpdated;
  const intervals = Math.floor(elapsed / this.defaults.decayIntervalMs);

  if (intervals > 0) {
    const decay = intervals * this.defaults.decayRate;
    score.value = Math.max(this.defaults.initial, score.value - decay);
    score.lastUpdated = Date.now();
  }
}
```

Decay floors at the initial score, not zero — the agent doesn't regress below its starting point just because time passed.

### Operation Categories

Operations are grouped by type, with each category tracking independently. Categories reflect the risk profile of the operation, not the specific tool used:

```javascript
const OPERATION_CATEGORIES = {
  'git-commit':      { initial: 0.3 },   // Low risk, higher starting confidence
  'file-edit':       { initial: 0.3 },
  'send-message':    { initial: 0.2 },
  'create-issue':    { initial: 0.2 },
  'deploy-staging':  { initial: 0.1 },   // Higher risk, start more cautious
  'deploy-production': { initial: 0.0 }, // Maximum caution
  'delete-resource': { initial: 0.0 },
};
```

## Implications

- Asymmetric update (failures penalized 3x more than successes reward) makes the system conservative by default. This is intentional — the cost of an unauthorized bad action outweighs the convenience of skipping confirmation.
- Decay prevents overconfidence from historical success. An agent that hasn't deployed in two weeks shouldn't auto-deploy based on a track record from last month.
- This pattern is complementary to decision gating, not a replacement. Decision gating controls notification tiers (critical, opportunity, status). Confidence gating controls whether the agent bypasses the approval step entirely. Both can coexist: a high-confidence operation might still generate a status notification even though it doesn't require approval.
- Per-category tracking means a failure in "deploy" doesn't affect confidence in "git-commit." This is appropriate for isolated operation types but doesn't capture correlated failures (e.g., a string of bad commits might predict bad deploys).
- The threshold, increment, and decrement values need tuning per deployment. The defaults are conservative but may be too restrictive for low-risk environments or too lenient for high-stakes ones.
- Persistence is critical — if confidence scores are lost on restart, the agent reverts to asking for everything. Scores should be persisted to disk or a database.

## Code Example

```javascript
// Reference implementation: Riley agent autonomy

const tracker = new ConfidenceTracker();

// Agent wants to commit code
async function handleGitCommit(changes) {
  const operation = 'git-commit';

  return tracker.executeOrAsk(
    operation,
    async () => {
      const result = await git.commit(changes);
      tracker.recordSuccess(operation);
      return result;
    },
    async (op, action) => {
      const approved = await requestHumanApproval(op, changes);
      if (approved) {
        const result = await action();
        tracker.recordSuccess(op);
        return result;
      }
      // Rejection isn't a failure — the agent made the right call by asking
      return null;
    }
  );
}

// Agent attempts a deploy that fails
async function handleDeploy(env, config) {
  const operation = `deploy-${env}`;

  try {
    const result = await deploy(env, config);
    tracker.recordSuccess(operation);
    return result;
  } catch (err) {
    tracker.recordFailure(operation);
    throw err;
  }
}

// Dashboard: inspect current confidence levels
function getConfidenceReport() {
  return Object.fromEntries(
    [...tracker.scores.entries()].map(([op, score]) => [
      op,
      {
        confidence: score.value.toFixed(2),
        autonomous: score.value >= tracker.defaults.autonomyThreshold,
        history: `${score.successes} successes, ${score.failures} failures`,
      },
    ])
  );
}
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
