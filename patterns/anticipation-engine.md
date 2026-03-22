# Anticipation Engine

> Domain-level confidence tracking with asymmetric scoring — successes slowly build confidence while failures rapidly reduce it.

## Problem

An agent that treats every action as equally trustworthy never learns from its mistakes. If it sends a poorly-formatted email, it should become more cautious about future emails. If it consistently creates good PRs, it should need less oversight for code operations. Without outcome-based confidence tracking, the agent either stays permanently cautious (frustrating) or permanently permissive (dangerous).

## Context

- An agent that takes actions across multiple domains (code, email, scheduling, project management)
- Some domains have higher success rates than others for a given deployment
- Confidence should inform autonomy decisions — high confidence in a domain allows more autonomous operation
- The system should be biased toward caution: failures must reduce confidence faster than successes build it
- Confidence is tracked per domain, not per individual operation type

## Solution

### Asymmetric Confidence Formula

Domain confidence uses an asymmetric update formula where corrections (failures) carry a 1.25x multiplier relative to successes. This means the system loses confidence faster than it gains it — a deliberate safety bias:

```javascript
// confidence.js
async function record(tenantId, domain, positive, weight = 1) {
  const successInc = positive ? weight : 0;
  const correctionInc = positive ? 0 : weight;

  await db.query(`
    INSERT INTO domain_confidence
      (tenant_id, domain, total_actions, successful_actions, corrections, confidence_score)
    VALUES ($1, $2, 1, $3, $4,
      GREATEST(0, LEAST(1, ($3::real - $4::real * 1.25) / NULLIF(1::real, 0)))
    )
    ON CONFLICT (tenant_id, domain) DO UPDATE SET
      total_actions = domain_confidence.total_actions + 1,
      successful_actions = domain_confidence.successful_actions + $3,
      corrections = domain_confidence.corrections + $4,
      confidence_score = GREATEST(0, LEAST(1,
        (domain_confidence.successful_actions + $3
         - (domain_confidence.corrections + $4) * 1.25)::real
        / NULLIF((domain_confidence.total_actions + 1)::real, 0)
      ))
  `, [tenantId, domain, successInc, correctionInc]);
}
```

### Score Interpretation

The formula produces a score between 0 and 1, clamped at both ends:

- **1.0** — All actions successful, no corrections
- **0.7-0.9** — Mostly successful, occasional corrections
- **0.4-0.6** — Mixed results, significant correction history
- **0.0** — Corrections dominate, domain effectively untrusted

The 1.25x multiplier means 5 corrections cancel approximately 6 successes — biasing toward caution without being overly punitive.

### Reading Confidence

Domain confidence is queried when making autonomy decisions. A high score in a domain may allow auto-execution; a low score may require explicit approval:

```javascript
async function getConfidence(tenantId, domain) {
  const row = await db.query(
    `SELECT confidence_score, total_actions FROM domain_confidence
     WHERE tenant_id = $1 AND domain = $2`,
    [tenantId, domain]
  );

  if (!row) return { score: 0.5, actions: 0 }; // Default: neutral
  return { score: row.confidence_score, actions: row.total_actions };
}
```

### Fire-and-Forget Recording

Confidence updates are non-blocking. The recording call does not gate the response path — if it fails, the action still proceeds:

```javascript
// In the action execution path
await executeAction(action);
record(tenantId, action.domain, true).catch(() => {});
```

## Implications

- The asymmetric multiplier (1.25x) is configurable per deployment, allowing tuning for different risk tolerances
- Domain-level granularity means a bad email experience affects all email operations — this may be too coarse for some use cases, but avoids the complexity of per-operation tracking
- Fire-and-forget recording means confidence tracking never blocks the response path, but also means updates can be lost under database pressure
- New domains start at a neutral default (0.5), not zero — the system doesn't penalize unfamiliarity
- Confidence scores are per-tenant, so one user's correction history doesn't affect another's
- The score naturally converges as `total_actions` grows — early corrections have outsized impact, which is intentional for safety

## Code Example

```javascript
// Domain confidence influencing autonomy decisions
const { score } = await getConfidence(tenantId, 'code_review');

if (score > 0.8) {
  // High confidence: auto-execute
  await executeAction(action);
} else if (score > 0.5) {
  // Medium confidence: notify user but proceed
  await notify(user, `Executing: ${action.description}`);
  await executeAction(action);
} else {
  // Low confidence: require explicit approval
  await requestApproval(user, action);
}
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
