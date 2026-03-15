# Confidence-Based Autonomy Gating

> Domain-level confidence tracking with asymmetric scoring and configurable correction multipliers, earning autonomy through successful track record across entire capability domains.

## Problem

Fixed autonomy levels are too rigid. An agent that always asks for permission is annoying; one that never does is dangerous. The right level of autonomy depends on the agent's track record — but tracking at the individual operation level is too granular (hundreds of operation types), while a single global score is too coarse (one bad email shouldn't affect code review confidence). Domain-level tracking strikes the balance.

## Context

- An autonomous agent making decisions with varying risk levels across different capability domains
- Complementary to static decision-gating tiers (AUTO/NOTIFY/ASK/NEVER), which control notification routing. This pattern controls whether the agent's confidence justifies bypassing approval.
- Different domains carry different risk profiles and should be tracked independently
- Confidence should bias toward caution — failures should matter more than successes

## Solution

### Domain-Level Confidence Tracking

Confidence scores are maintained per domain (e.g., 'code_review', 'email', 'task_management'), not per individual operation. This groups related operations under a single trust metric:

```javascript
// vibe/confidence.js
// Scores stored in domain_confidence table:
// tenant_id | domain | total_actions | successful_actions | corrections | confidence_score
```

### Asymmetric Scoring Formula

The scoring formula weights corrections 1.25x heavier than successes, biasing the system toward caution:

```sql
confidence_score = GREATEST(0, LEAST(1,
  (successful_actions - corrections * 1.25) / NULLIF(total_actions, 0)
))
```

With this formula:
- 10 successes, 0 corrections → confidence = 1.0
- 10 successes, 4 corrections → confidence = (10 - 5) / 14 = 0.36
- 5 corrections cancel ~6 successes worth of confidence

The multiplier (1.25) is configurable per deployment — higher-risk environments can increase it.

### Fire-and-Forget Signal Recording

Confidence signals are recorded asynchronously to avoid blocking the response path:

```javascript
async function record(tenantId, domain, positive, weight = 1) {
  const successInc = positive ? weight : 0;
  const correctionInc = positive ? 0 : weight;

  // Non-blocking upsert with atomic score recalculation
  await db.query(`
    INSERT INTO domain_confidence
      (tenant_id, domain, total_actions, successful_actions, corrections, confidence_score, last_updated)
    VALUES ($1, $2, $3, $4, $5,
      GREATEST(0, LEAST(1, ($4::real - $5::real * 1.25) / NULLIF($3::real, 0))),
      NOW())
    ON CONFLICT (tenant_id, domain) DO UPDATE SET
      total_actions = domain_confidence.total_actions + $3,
      successful_actions = domain_confidence.successful_actions + $4,
      corrections = domain_confidence.corrections + $5,
      confidence_score = GREATEST(0, LEAST(1,
        (domain_confidence.successful_actions + $4
         - (domain_confidence.corrections + $5) * 1.25)::real
        / NULLIF((domain_confidence.total_actions + $3)::real, 0)
      )),
      last_updated = NOW()
  `, [tenantId, domain, 1, successInc, correctionInc]);
}

// Called fire-and-forget from tool execution:
confidence.record(tenantId, 'code_review', true).catch(() => {});
```

### Autonomy Integration

Confidence scores feed into the autonomy decision at tool execution time:

```javascript
// message-processor/autonomy.js
async function executeToolWithAutonomy(toolName, args, userId, options = {}) {
  const tool = registry.get(toolName);
  const domain = tool.domain || 'general';
  const score = await confidence.getScore(userId, domain);

  // High confidence + AUTO tier → execute without asking
  if (tool.autonomyTier === 'AUTO' || (tool.autonomyTier === 'NOTIFY' && score > 0.8)) {
    const result = await tool.execute(args);
    confidence.record(userId, domain, true).catch(() => {});
    return result;
  }

  // Low confidence or ASK tier → require approval
  if (tool.autonomyTier === 'ASK' || score < 0.3) {
    return await requestApproval(userId, toolName, args);
  }

  // Middle ground: execute and notify
  const result = await tool.execute(args);
  await notify(userId, `Executed ${toolName}`, result);
  confidence.record(userId, domain, true).catch(() => {});
  return result;
}
```

### Integration with Outcome Reactor

The vibe subsystem's outcome reactor automatically updates confidence when external events confirm or deny action outcomes:

```javascript
// PR merged → positive signal for 'code_review' domain
events.on('github.pr_merged', (event) => {
  confidence.record(event.tenantId, 'code_review', true);
});

// PR closed without merge → negative signal
events.on('github.pr_closed', (event) => {
  if (!event.merged) {
    confidence.record(event.tenantId, 'code_review', false);
  }
});
```

## Implications

- Domain-level tracking means a bad email experience affects all email operations — this may be too coarse for some use cases, but is simpler to reason about than per-operation tracking
- The 1.25x correction multiplier is deliberately mild — it takes ~6 corrections to cancel 5 successes, making the system cautious but not punitive
- Fire-and-forget recording means confidence tracking never adds latency to tool execution
- Atomic database upsert ensures confidence scores are consistent even under concurrent access
- No time-based decay — confidence is purely based on cumulative success/correction ratio. Stale confidence from months ago carries equal weight to recent signals
- This pattern complements static tiers (AUTO/NOTIFY/ASK/NEVER) — tiers set the baseline, confidence fine-tunes within the tier's range

## Code Example

```javascript
// Complete confidence lifecycle:
// 1. Agent executes a tool
const result = await executeToolWithAutonomy('create_pr', prArgs, userId);

// 2. Confidence recorded (fire-and-forget)
// confidence.record(userId, 'code_review', true)

// 3. Hours later, PR outcome observed via webhook
// events.emit('github.pr_merged', { tenantId: userId, pr: { ... } })
// → confidence.record(userId, 'code_review', true)

// 4. After many successful PRs, confidence for 'code_review' exceeds 0.8
// → Future PR-related tools auto-execute even if their tier is 'NOTIFY'

// 5. A correction occurs (user rejects a PR the agent created)
// confidence.record(userId, 'code_review', false)
// → Score drops, future PRs may require notification again
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Anticipation Engine](./anticipation-engine.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
