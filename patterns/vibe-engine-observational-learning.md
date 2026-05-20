# Vibe Engine: Observational Learning Loop

> Five-subsystem learning loop where the agent schedules follow-up checks on its own actions, auto-resolves outcomes from inbound events, infers preferences from behavior, identifies knowledge gaps, and tracks per-domain confidence — turning every action into a future training signal.

## Problem

An agent that takes actions without tracking outcomes can't tell good calls from bad ones — every action looks like a success in the moment it executes. Without a feedback loop, the agent's autonomy ceiling is fixed forever: the system can't say "you've handled 50 GitHub PR triages with 96% success, so you can do this one without asking." And without observed outcomes, the user has no basis for raising the autonomy ceiling either. The result is a permanent NOTIFY/ASK regime with no path to earned autonomy.

## Context

- The agent takes actions that have observable downstream outcomes (PR merged, email replied, task completed, meeting attended)
- Many of those outcomes arrive as external events (GitHub webhook, calendar update, user reply) on a delay
- Some outcomes never arrive — they have to be checked actively (did the customer respond? did the task get done?)
- Autonomy should be earned per-domain: confident in GitHub triage doesn't mean confident in customer email
- The agent needs to know what it doesn't know, so it can ask targeted questions rather than guess

## Solution

The vibe engine (`lib/vibe/`) is five cooperating subsystems sharing a single event bus and a single confidence table:

1. **follow-ups** — schedule a future check on any action the agent takes
2. **outcome-reactor** — subscribe to the event bus and auto-resolve follow-ups when matching events arrive
3. **knowledge-gaps** — track what the agent doesn't know and generate targeted questions
4. **synthesizer** — infer preferences from observed behavior patterns
5. **confidence** — per-domain confidence score that aggregates outcomes into a 0–1 number

Together they form a loop: action → scheduled follow-up → observed outcome → confidence update → future autonomy decision.

### Follow-Up Scheduling

When the agent takes a significant action, it schedules a follow-up with the expected outcome and a check time:

```javascript
// lib/vibe/follow-ups.js
async function schedule({ actionType, targetType, targetId, expectedOutcome, checkAfterMs, metadata }) {
  const checkAfter = new Date(Date.now() + checkAfterMs).toISOString()
  return rawOneWithTenant(
    `INSERT INTO follow_ups (tenant_id, action_type, target_type, target_id,
                              expected_outcome, check_after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actionType, targetType, String(targetId), expectedOutcome, checkAfter, metadata]
  )
}
```

Example: after sending a customer follow-up email, schedule a check 48 hours out for "customer replied."

### Outcome Reactor: Event-Driven Resolution

Most outcomes arrive without anyone asking. The outcome reactor subscribes to the unified event bus and resolves matching follow-ups automatically:

```javascript
// lib/vibe/outcome-reactor.js
async function resolveFollowUps(targetType, targetId, outcome, domain, notes) {
  const pending = await followUps.getForTarget(targetType, targetId)
  for (const item of pending) {
    await followUps.recordOutcome(item.id, { outcome, notes })
  }
  confidence.recordSignal({
    domain, positive: outcome === 'success', weight: 1, source: 'outcome_reactor',
  })
}

async function onPrMerged(payload) {
  await resolveFollowUps('pr', String(payload.number), 'success', 'github', 'PR merged')
}

async function onPrClosed(payload) {
  // closed without merge = failure
  await resolveFollowUps('pr', String(payload.number), 'failure', 'github', 'PR closed unmerged')
}
```

The handlers cover GitHub events, task completions, calendar updates, and other event types — each translates a domain-specific event into the generic `resolveFollowUps` shape.

### Domain Confidence Aggregation

Confidence is per-domain (github, tasks, email, calendar) and updates fire-and-forget on every signal. The score is `(successes - corrections * 1.25) / total`, clamped to [0, 1]. Corrections are weighted 1.25× failures because an explicit user correction is a stronger negative signal than a mere bad outcome:

```javascript
// lib/vibe/confidence.js
async function _doRecord(tenantId, domain, positive, weight) {
  const successInc = positive ? weight : 0
  const correctionInc = positive ? 0 : weight

  await raw(
    `INSERT INTO domain_confidence
       (tenant_id, domain, total_actions, successful_actions, corrections,
        confidence_score, last_updated)
     VALUES ($1, $2, $3, $4, $5,
       GREATEST(0, LEAST(1, ($4 - $5 * 1.25) / NULLIF($3, 0))), NOW())
     ON CONFLICT (tenant_id, domain) DO UPDATE SET
       total_actions = domain_confidence.total_actions + $3,
       successful_actions = domain_confidence.successful_actions + $4,
       corrections = domain_confidence.corrections + $5,
       confidence_score = GREATEST(0, LEAST(1,
         (domain_confidence.successful_actions + $4
          - (domain_confidence.corrections + $5) * 1.25)::real
         / NULLIF((domain_confidence.total_actions + $3)::real, 0))),
       last_updated = NOW()`,
    [tenantId, domain, weight, successInc, correctionInc],
  )
}
```

### Knowledge Gaps and Behavior Synthesis

`knowledge-gaps` records uncertainty as structured questions the agent can ask the user when context allows. `synthesizer` infers preferences from observed behavior — "user merges PRs from contributor X without review" becomes a stored preference that informs future autonomy decisions in that domain.

### Wiring at Startup

The reactor is the only subsystem with side effects on the bus; init wires it up, shutdown tears it down:

```javascript
// lib/vibe/index.js
function init() {
  outcomeReactor.init()       // subscribes to event bus
  logger.info('Engine initialized')
}

function shutdown() {
  outcomeReactor.shutdown()   // unsubscribes
}

module.exports = {
  init, shutdown,
  followUps, outcomeReactor, knowledgeGaps, synthesizer, confidence,
}
```

## Implications

- **Outcomes attribute themselves** — most follow-ups resolve without anyone polling, because the event bus already carries the signal; the reactor is the bridge
- **Per-domain confidence enables earned autonomy** — a single global "agent trustworthiness" number would be useless; per-domain numbers let the autonomy system grant elevated tiers exactly where the agent has earned them
- **Corrections weighted heavier than failures** — a user reaching in to correct is a stronger "you got this wrong" signal than an outcome that just didn't pan out; the 1.25× multiplier reflects that
- **Active follow-ups catch silent failures** — some outcomes (customer didn't reply, task didn't get done) only show up by absence; scheduled checks notice the absence
- **Fire-and-forget confidence updates** — `recordSignal` doesn't block the calling action; the cost is occasional lost updates if the process dies between signal and write
- **Five subsystems sharing one bus** — coordination via events keeps each subsystem testable in isolation; the engine's `init()` is the only place that knows about the wiring
- **The loop is the product** — no single subsystem is interesting; the value is the closed loop that turns action history into a forecast of future reliability

## Code Example

```javascript
const vibe = require('./lib/vibe')

// At startup
vibe.init()

// After the agent merges a PR autonomously
await vibe.followUps.schedule({
  actionType: 'pr_merged',
  targetType: 'pr',
  targetId: pr.number,
  expectedOutcome: 'no rollback within 24h',
  checkAfterMs: 24 * 60 * 60 * 1000,
  metadata: { repo: pr.base.repo.full_name, author: pr.user.login },
})

// 24h later — followup checker runs
const due = await vibe.followUps.getDue(20)
for (const item of due) {
  const rolledBack = await checkForRollback(item.metadata.repo, item.target_id)
  await vibe.followUps.recordOutcome(item.id, {
    outcome: rolledBack ? 'failure' : 'success',
    notes: rolledBack ? 'PR was reverted' : 'No rollback observed',
  })
  vibe.confidence.recordSignal({
    domain: 'github_autonomous_merge',
    positive: !rolledBack,
    weight: 1,
    source: 'rollback_check',
  })
}

// Later, autonomy gating consults the confidence score
const score = await vibe.confidence.getScore('github_autonomous_merge')
if (score > 0.9 && totalActions > 50) {
  // Trustworthy enough to auto-execute the next PR merge in this domain
}
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Unified Event System](./unified-event-system.md)
- [Time-Boxed Autonomy Boost](./time-boxed-autonomy-boost.md)
