# Decision Gating and Autonomy Tiers

> Route autonomous agent decisions through notification tiers to prevent alert fatigue while ensuring critical actions reach humans.

## Problem

Autonomous agents make many decisions — some trivial (status updates), some important (deployment opportunities), some critical (production errors). Without structured notification routing, agents either spam humans with every decision (alert fatigue → humans ignore everything) or operate too silently (critical issues go unnoticed). The agent needs a per-project, per-decision routing policy.

## Context

- An orchestrator managing multiple projects with different autonomy expectations
- Decisions that vary in urgency and consequence across projects
- Human operators who need to stay informed without being overwhelmed
- Systems that evolve over time — a decision that starts as critical may become routine

## Solution

### Three-Tier Notification Model

Every autonomous decision is classified into one of three tiers:

| Tier | Behavior | Use Case |
|------|----------|----------|
| `critical` | Immediate push notification, always fires | Production errors, security events, blocking failures |
| `opportunity` | Rate-limited: max 1 notification per hour per project+decision | Deploy suggestions, optimization findings, PR review requests |
| `status` | Silent, dashboard-only | Routine health checks, successful cron runs, minor state changes |

### Per-Project Configuration

Each project declares its autonomy policy in `.riley/autonomy.yaml`:

```yaml
version: 1
defaults:
  notification_tier: status
  escalation_timeout: 3600  # seconds before escalating unresolved decisions

decisions:
  - name: deploy-suggestion
    tier: opportunity
  - name: error-recovery
    tier: critical
  - name: maintenance-complete
    tier: status
```

### Rate-Limiting with Opportunity Windows

The `opportunity` tier prevents notification spam through a per-project, per-decision gate:

```javascript
const OPPORTUNITY_WINDOW = 60 * 60 * 1000; // 1 hour

function shouldNotify(projectName, decisionName, tier) {
  // Record for dashboard regardless of tier
  recentDecisions.unshift({ projectName, decisionName, tier, ts: Date.now() });

  if (tier === 'critical') return true;
  if (tier === 'status') return false;

  // Opportunity: at most once per hour per project+decision
  const key = `${projectName}:${decisionName}`;
  const last = opportunityGate.get(key) ?? 0;
  if (Date.now() - last < OPPORTUNITY_WINDOW) return false;
  opportunityGate.set(key, Date.now());
  return true;
}
```

### Configuration Loading with Caching

Autonomy configs are loaded from each project's `.riley/` directory, cached in memory, and invalidated on project re-registration:

```javascript
function getDecisionTier(projectName, decisionName, defaultTier = 'status') {
  const config = getConfig(projectName);
  const decision = config?.decisions?.find(d => d.name === decisionName);
  return {
    tier: decision?.tier ?? config?.defaults?.notification_tier ?? defaultTier,
    escalation_timeout: decision?.escalation_timeout ?? config?.defaults?.escalation_timeout ?? 3600,
  };
}
```

### Decision Audit Trail

A ring buffer of the 100 most recent routing decisions powers the dashboard view, making the agent's decision-making transparent:

```javascript
const recentDecisions = [];
const MAX_RECENT = 100;

// Each decision recorded with project, name, tier, timestamp
recentDecisions.unshift({ projectName, decisionName, tier, ts: Date.now() });
if (recentDecisions.length > MAX_RECENT) recentDecisions.pop();
```

## Implications

- Default tier is `status` (silent) — projects are quiet by default and opt in to noisier tiers
- The opportunity window is global (1 hour) — some projects may want shorter/longer windows
- Escalation timeouts are declared but enforcement depends on the consuming system wiring them up
- In-memory rate-limiting means opportunity gates reset on restart — a restart could cause a burst of notifications
- Config caching means changes to `autonomy.yaml` don't take effect until cache invalidation (project re-registration)
- No "off" tier — even status decisions are recorded to the dashboard, maintaining full auditability

## Code Example

```yaml
# .riley/autonomy.yaml for a production API project
version: 1
defaults:
  notification_tier: opportunity
  escalation_timeout: 1800  # 30 minutes

decisions:
  - name: health-check-failure
    tier: critical
  - name: auto-scaling-event
    tier: status
  - name: dependency-update-available
    tier: opportunity
  - name: ssl-cert-expiry
    tier: critical
    escalation_timeout: 300  # 5 minutes
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
