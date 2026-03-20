# Decision Gating and Autonomy Tiers

> Route autonomous agent decisions through notification tiers to prevent alert fatigue while ensuring critical actions reach humans.

## Problem

Autonomous agents make many decisions — some trivial (status updates), some important (deployment opportunities), some critical (production errors). Without structured routing, agents either spam humans with every decision (alert fatigue leads to humans ignoring everything) or operate too silently (critical issues go unnoticed). The system needs a centralized policy that classifies decisions by urgency and routes them accordingly.

## Context

- An orchestrator managing multiple projects with different autonomy expectations
- Decisions that vary in urgency and consequence
- Human operators who need to stay informed without being overwhelmed
- Systems that evolve over time — a decision that starts as critical may become routine

## Solution

### Three-Tier Autonomy Model

Every autonomous decision is classified into one of three numeric tiers:

| Tier | Name | Behavior | Use Case |
|------|------|----------|----------|
| 1 | AUTO | Execute silently, logged only | Routine health checks, successful cron runs, minor state changes |
| 2 | NOTIFY | Execute and notify human after the fact (rate-limited per window) | Deploy suggestions, optimization findings, PR review requests |
| 3 | ASK | Block and request human approval before executing | Production errors, security events, blocking failures |

### Dynamic Rule Evaluation

Rather than a static lookup table, tier assignment is computed at runtime by `lib/agent/autonomy-rules.js`. Rules evaluate context, domain confidence (from `autonomyTracker`), and action fingerprints to produce a numeric confidence score (0–1). That score is then mapped to a tier:

```javascript
// lib/agent/autonomy-rules.js — rules evaluate at runtime, not at deploy time
import { autonomyTracker } from './autonomy-tracker.js';

const rules = [
  {
    name: 'domain-confidence',
    evaluate(context) {
      const score = autonomyTracker.getDomainConfidence(context.domain);
      // High tracked confidence → lean AUTO; low or unknown → lean ASK
      return score;
    }
  },
  {
    name: 'action-fingerprint',
    evaluate(context) {
      const fingerprint = computeActionFingerprint(context.action, context.params);
      const history = autonomyTracker.getFingerprintHistory(fingerprint);
      if (!history) return 0.5;  // unknown action — neutral
      return history.successRate;
    }
  },
  {
    name: 'blast-radius',
    evaluate(context) {
      // Destructive or production-scoped actions reduce confidence
      if (context.scope === 'production' || context.destructive) return 0.1;
      if (context.scope === 'staging') return 0.7;
      return 0.9;
    }
  },
];

export function evaluateTier(context) {
  const scores = rules.map(r => r.evaluate(context));
  const confidence = scores.reduce((a, b) => a + b, 0) / scores.length;

  if (confidence >= 0.85) return { tier: 1, label: 'AUTO',   confidence };
  if (confidence >= 0.50) return { tier: 2, label: 'NOTIFY', confidence };
  return                         { tier: 3, label: 'ASK',    confidence };
}
```

The three tiers remain the output classification — AUTO, NOTIFY, ASK — but the input is dynamic rather than a fixed enum lookup.

### Autonomy Boost: NOTIFY → AUTO Promotion

The `autonomy-boost` subsystem tracks consecutive approvals per action fingerprint. When a NOTIFY-tier action is approved by the human enough times in a row, it is promoted to AUTO:

```javascript
// autonomy-boost: promotes NOTIFY → AUTO on repeated approval
export function recordApproval(fingerprint) {
  const record = autonomyTracker.getOrCreate(fingerprint);
  record.consecutiveApprovals += 1;

  if (record.consecutiveApprovals >= BOOST_THRESHOLD) {
    // Promote: future evaluations will see high confidence for this fingerprint
    autonomyTracker.setFingerprintConfidence(fingerprint, 0.92);
    record.consecutiveApprovals = 0;  // reset streak
  }
}

export function recordRejection(fingerprint) {
  const record = autonomyTracker.getOrCreate(fingerprint);
  record.consecutiveApprovals = 0;  // break the streak on any rejection
  autonomyTracker.decayFingerprintConfidence(fingerprint, 0.15);
}
```

This replaces the static `decisions` map: new action types start unknown (neutral confidence), earn AUTO status through demonstrated approval history, and lose it on rejection.

### Notification Batching for Tier 2

Tier 2 (NOTIFY) prevents notification spam through a per-project, per-decision batching window:

```javascript
const notifyGate = new Map();

function shouldNotify(projectName, decisionName) {
  const tier = getDecisionTier(decisionName);

  // Always record for audit trail
  recordDecision(projectName, decisionName, tier);

  if (tier === 3) return true;   // ASK — always notify, block for approval
  if (tier === 1) return false;  // AUTO — silent, logged only

  // NOTIFY (tier 2): at most once per window per project+decision
  const key = `${projectName}:${decisionName}`;
  const last = notifyGate.get(key) ?? 0;
  const window = decisionPolicy.defaults.notifyWindowMs;

  if (Date.now() - last < window) return false;
  notifyGate.set(key, Date.now());
  return true;
}
```

### Decision Audit Trail

A ring buffer of recent routing decisions powers observability. Every decision is recorded regardless of tier, making the agent's decision-making transparent even when notifications are suppressed:

```javascript
const recentDecisions = [];
const MAX_RECENT = 100;

function recordDecision(projectName, decisionName, tier) {
  recentDecisions.unshift({
    projectName,
    decisionName,
    tier,
    ts: Date.now(),
  });
  if (recentDecisions.length > MAX_RECENT) recentDecisions.pop();
}

// Dashboard endpoint exposes full audit trail
function getRecentDecisions() {
  return recentDecisions;
}
```

## Implications

- Default confidence for unknown actions is neutral (0.5 → NOTIFY) — agents are not silently autonomous for new action types until they build a track record
- Dynamic rules mean tier assignment can shift at runtime without code deploys — `autonomyTracker` state is the live source of truth for routing behavior
- The autonomy-boost streak counter resets on any rejection, making demotion fast and promotion slow by design
- The tier 2 batching window is global — different action types may warrant different rate limits in practice
- In-memory rate-limiting and tracker state reset on orchestrator restart, which could cause a brief burst of tier 2 notifications and temporary loss of promotion history
- No "off" tier — even tier 1 (AUTO) decisions are recorded in the audit trail, maintaining full observability
- The three-tier output model is deliberately stable. The complexity lives in the rule evaluation layer, not in the tier definitions themselves

## Code Example

```javascript
// Reference implementation: Riley orchestrator

// An agent reports a decision during autonomous operation
async function handleAgentDecision(project, action, details) {
  const context = {
    domain: project,
    action: action.type,
    params: action.params,
    scope: action.scope ?? 'unknown',
    destructive: action.destructive ?? false,
  };

  const { tier, label, confidence } = evaluateTier(context);
  const fingerprint = computeActionFingerprint(action.type, action.params);

  recordDecision(project, action.type, tier, confidence);

  if (tier === 3) {
    // ASK — block and wait for human approval
    const approved = await requestApproval({ project, action, tier, confidence, details });
    if (approved) recordApproval(fingerprint);
    else           recordRejection(fingerprint);
    return;
  }

  if (shouldNotify(project, action.type)) {
    // NOTIFY (tier 2) — execute and inform human after the fact
    await sendNotification({
      project,
      action: action.type,
      tier,
      confidence,
      details,
      timestamp: new Date().toISOString(),
    });
    // Implicit approval — count toward boost streak
    recordApproval(fingerprint);
  }

  // AUTO (tier 1) — silent execution, recorded in audit trail only
}

// Usage from a flow step
handleAgentDecision('billing-api',
  { type: 'deploy-suggestion', scope: 'production', destructive: false, params: { branch: 'feature/new-pricing' } },
  'All tests pass. Ready for production deploy.');

// First call (unknown fingerprint): confidence ~0.5 → NOTIFY, notifies, records approval
// After BOOST_THRESHOLD consecutive approvals: fingerprint confidence → 0.92 → AUTO
// scope:'production' + destructive:true: blast-radius rule lowers confidence → ASK
```

## Relationship to Other Autonomy Patterns

This pattern, [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md), and [Deliberative Alignment](./deliberative-alignment.md) form a three-layer autonomy system:

- **Decision Gating (this pattern)** — Dynamic routing policy. `autonomy-rules.js` evaluates context, domain confidence, and action fingerprints at runtime to produce a tier (AUTO/NOTIFY/ASK). The `autonomy-boost` subsystem promotes NOTIFY → AUTO based on consecutive approval history. This is the outermost layer — it determines _how_ a decision is communicated and whether its tier has been earned.
- **Confidence-Based Autonomy Gating** — Persistent trust scoring. Tracks per-domain success/failure ratios; those scores feed directly into the rule evaluation above. The two patterns share `autonomyTracker` as a common substrate.
- **Deliberative Alignment** — Tiebreaker for the middle ground. When confidence falls in the notify band (0.50–0.85), multi-model voting resolves whether to execute or queue. This is the innermost layer — it handles ambiguous cases that neither dynamic rules nor tracker history can resolve alone.

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Deliberative Alignment](./deliberative-alignment.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
