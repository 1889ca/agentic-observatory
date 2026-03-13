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

### Three-Tier Notification Model

Every autonomous decision is classified into one of three tiers:

| Tier | Behavior | Use Case |
|------|----------|----------|
| `critical` | Immediate push notification, always fires | Production errors, security events, blocking failures |
| `opportunity` | Rate-limited: max 1 notification per window per project+decision | Deploy suggestions, optimization findings, PR review requests |
| `status` | Silent, logged only | Routine health checks, successful cron runs, minor state changes |

### Centralized Decision Policy

The orchestrator maintains a centralized policy that defines decision tiers programmatically. Rather than scattering configuration across projects, the policy lives within the orchestrator itself:

```javascript
// Decision tier registry — centralized in the orchestrator
const decisionPolicy = {
  defaults: {
    tier: 'status',
    opportunityWindowMs: 60 * 60 * 1000, // 1 hour
  },

  decisions: {
    'health-check-failure':  { tier: 'critical' },
    'deploy-suggestion':     { tier: 'opportunity' },
    'error-recovery':        { tier: 'critical' },
    'maintenance-complete':  { tier: 'status' },
    'dependency-update':     { tier: 'opportunity' },
    'ssl-cert-expiry':       { tier: 'critical' },
  },
};

function getDecisionTier(decisionName) {
  const entry = decisionPolicy.decisions[decisionName];
  return entry?.tier ?? decisionPolicy.defaults.tier;
}
```

This centralized approach means the orchestrator has a single source of truth for all routing decisions. Adding new decision types or changing tiers is a code change in one place, not a config file hunt across projects.

### Rate-Limiting with Opportunity Windows

The `opportunity` tier prevents notification spam through a per-project, per-decision gate:

```javascript
const opportunityGate = new Map();

function shouldNotify(projectName, decisionName) {
  const tier = getDecisionTier(decisionName);

  // Always record for audit trail
  recordDecision(projectName, decisionName, tier);

  if (tier === 'critical') return true;
  if (tier === 'status') return false;

  // Opportunity: at most once per window per project+decision
  const key = `${projectName}:${decisionName}`;
  const last = opportunityGate.get(key) ?? 0;
  const window = decisionPolicy.defaults.opportunityWindowMs;

  if (Date.now() - last < window) return false;
  opportunityGate.set(key, Date.now());
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

- Default tier is `status` (silent) — agents are quiet by default and opt in to noisier tiers
- Centralized policy avoids configuration drift across projects but requires orchestrator changes to update tiers
- The opportunity window is global — different decision types may warrant different rate limits in practice
- In-memory rate-limiting means opportunity gates reset on orchestrator restart, which could cause a brief burst of notifications
- No "off" tier — even status decisions are recorded in the audit trail, maintaining full observability
- The three-tier model is deliberately simple. More granular systems (5+ tiers, per-user routing) add complexity without proportional benefit for most deployments

## Code Example

```javascript
// Reference implementation: Riley orchestrator

// An agent reports a decision during autonomous operation
async function handleAgentDecision(project, decision, details) {
  if (shouldNotify(project, decision)) {
    await sendNotification({
      project,
      decision,
      tier: getDecisionTier(decision),
      details,
      timestamp: new Date().toISOString(),
    });
  }
}

// Usage from a flow step
handleAgentDecision('billing-api', 'deploy-suggestion',
  'All tests pass on feature/new-pricing. Ready for production deploy.');

// First call: notifies (opportunity tier, no recent notification)
// Second call within 1 hour: suppressed (opportunity window active)
// 'health-check-failure': always notifies (critical tier)
// 'maintenance-complete': never notifies (status tier, logged only)
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
