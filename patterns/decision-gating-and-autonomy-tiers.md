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

### Centralized Decision Policy

The orchestrator maintains a centralized policy that defines decision tiers programmatically. Rather than scattering configuration across projects, the policy lives within the orchestrator itself:

```javascript
// Decision tier registry — centralized in the orchestrator
// 1 = AUTO, 2 = NOTIFY, 3 = ASK
const decisionPolicy = {
  defaults: {
    tier: 1,  // AUTO — silent by default
    notifyWindowMs: 60 * 60 * 1000, // 1 hour batching window for tier 2
  },

  decisions: {
    'health-check-failure':  { tier: 3 },  // ASK
    'deploy-suggestion':     { tier: 2 },  // NOTIFY
    'error-recovery':        { tier: 3 },  // ASK
    'maintenance-complete':  { tier: 1 },  // AUTO
    'dependency-update':     { tier: 2 },  // NOTIFY
    'ssl-cert-expiry':       { tier: 3 },  // ASK
  },
};

function getDecisionTier(decisionName) {
  const entry = decisionPolicy.decisions[decisionName];
  return entry?.tier ?? decisionPolicy.defaults.tier;
}
```

This centralized approach means the orchestrator has a single source of truth for all routing decisions. Adding new decision types or changing tiers is a code change in one place, not a config file hunt across projects.

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

- Default tier is 1 (AUTO, silent) — agents are quiet by default and opt in to noisier tiers
- Centralized policy avoids configuration drift across projects but requires orchestrator changes to update tiers
- The tier 2 batching window is global — different decision types may warrant different rate limits in practice
- In-memory rate-limiting means notification gates reset on orchestrator restart, which could cause a brief burst of tier 2 notifications
- No "off" tier — even tier 1 (AUTO) decisions are recorded in the audit trail, maintaining full observability
- The three-tier numeric model is deliberately simple. More granular systems (5+ tiers, per-user routing) add complexity without proportional benefit for most deployments

## Code Example

```javascript
// Reference implementation: Riley orchestrator

// An agent reports a decision during autonomous operation
async function handleAgentDecision(project, decision, details) {
  const tier = getDecisionTier(decision);

  if (tier === 3) {
    // ASK — block and wait for human approval
    await requestApproval({ project, decision, tier, details });
    return;
  }

  if (shouldNotify(project, decision)) {
    // NOTIFY (tier 2) — execute and inform human after the fact
    await sendNotification({
      project,
      decision,
      tier,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  // AUTO (tier 1) — silent execution, recorded in audit trail only
}

// Usage from a flow step
handleAgentDecision('billing-api', 'deploy-suggestion',
  'All tests pass on feature/new-pricing. Ready for production deploy.');

// First call: notifies (tier 2 NOTIFY, no recent notification)
// Second call within 1 hour: suppressed (batching window active)
// 'health-check-failure': blocks for approval (tier 3 ASK)
// 'maintenance-complete': silent (tier 1 AUTO, logged only)
```

## Relationship to Other Autonomy Patterns

This pattern, [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md), and [Deliberative Alignment](./deliberative-alignment.md) form a three-layer autonomy system:

- **Decision Gating (this pattern)** — Static routing policy. Classifies decisions by type into tiers (AUTO/NOTIFY/ASK) and controls notification delivery. This is the outermost layer — it determines _how_ a decision is communicated.
- **Confidence-Based Autonomy Gating** — Dynamic trust scoring. Tracks per-domain success/failure ratios to adjust whether a NOTIFY-tier action can be auto-executed or needs approval. This modulates the static tiers based on track record.
- **Deliberative Alignment** — Tiebreaker for the middle ground. When confidence falls in the notify band (0.60-0.85), multi-model voting resolves whether to execute or queue. This is the innermost layer — it handles ambiguous cases that neither static tiers nor confidence scoring can resolve alone.

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Deliberative Alignment](./deliberative-alignment.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
