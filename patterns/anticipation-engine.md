# Anticipation Engine

> Reactive vibe subsystem that tracks action outcomes, auto-resolves follow-ups from observed events, and adjusts domain confidence — replacing speculative prediction with evidence-based reactivity.

## Problem

A purely reactive agent forgets what it did the moment a conversation ends. It can't verify whether an action it took actually succeeded — did that PR get merged? Did the email get a reply? Did the scheduled task complete? Without outcome tracking, the agent has no feedback loop: it can't learn which actions succeed, adjust its confidence, or proactively surface stalled work.

## Context

- An agent that takes actions with delayed outcomes (PRs, emails, deployments, scheduled tasks)
- Outcomes arrive asynchronously through external events (GitHub webhooks, task completions)
- Need to close the loop between "action taken" and "outcome observed"
- Confidence in specific domains should adjust based on actual success/failure rates
- The system should be reactive (respond to observed events) rather than speculative (predict based on temporal patterns)

## Solution

### Follow-Up Scheduling

When the agent takes a significant action, it schedules a follow-up check — a record of what was done, what outcome is expected, and when to verify:

```javascript
// vibe/follow-ups.js
async function schedule({ action, expectedOutcome, checkAfter, context }) {
  await db.query(`
    INSERT INTO follow_ups (action, expected_outcome, check_after, context, status)
    VALUES ($1, $2, $3, $4, 'pending')
  `, [action, expectedOutcome, checkAfter, JSON.stringify(context)]);
}

// Retrieve follow-ups that are past their check time
async function getDue() {
  return db.query(`
    SELECT * FROM follow_ups
    WHERE status = 'pending' AND check_after <= NOW()
    ORDER BY check_after ASC
  `);
}
```

Follow-up delays are configured per action type:

```javascript
const FOLLOW_UP_DELAYS = {
  entity: 60 * 60 * 1000,        // 1 hour
  send_email: 24 * 60 * 60 * 1000, // 24 hours
  create_event: 2 * 60 * 60 * 1000, // 2 hours
  create_pr: 4 * 60 * 60 * 1000,   // 4 hours
};
```

### Outcome Reactor

Instead of polling for outcomes, the system subscribes to events and auto-resolves matching follow-ups when outcomes are observed:

```javascript
// vibe/outcome-reactor.js
function init() {
  events.on('github.pr_merged', onPrMerged);
  events.on('github.pr_closed', onPrClosed);
  events.on('task.completed', onTaskCompleted);
  events.on('worker_task.completed', onWorkerTaskCompleted);
}

async function onPrMerged(event) {
  // Find follow-ups related to this PR
  const related = await findRelatedFollowUps('create_pr', event.pr);
  for (const followUp of related) {
    await resolve(followUp.id, {
      outcome: 'success',
      event: 'pr_merged',
      details: event,
    });
    // Positive signal → increase domain confidence
    confidence.record(followUp.context.tenantId, 'code_review', true);
  }
}

async function onPrClosed(event) {
  const related = await findRelatedFollowUps('create_pr', event.pr);
  for (const followUp of related) {
    await resolve(followUp.id, {
      outcome: 'closed_without_merge',
      event: 'pr_closed',
    });
    // Negative signal → decrease domain confidence
    confidence.record(followUp.context.tenantId, 'code_review', false);
  }
}
```

### Domain Confidence Tracking

Confidence scores are maintained per domain (not per operation type), using an asymmetric formula where corrections weigh 1.25x more than successes:

```javascript
// vibe/confidence.js
async function record(tenantId, domain, positive, weight = 1) {
  const successInc = positive ? weight : 0;
  const correctionInc = positive ? 0 : weight;

  await db.query(`
    INSERT INTO domain_confidence (tenant_id, domain, total_actions, successful_actions, corrections, confidence_score)
    VALUES ($1, $2, $3, $4, $5,
      GREATEST(0, LEAST(1, ($4::real - $5::real * 1.25) / NULLIF($3::real, 0)))
    )
    ON CONFLICT (tenant_id, domain) DO UPDATE SET
      total_actions = domain_confidence.total_actions + $3,
      successful_actions = domain_confidence.successful_actions + $4,
      corrections = domain_confidence.corrections + $5,
      confidence_score = GREATEST(0, LEAST(1,
        (domain_confidence.successful_actions + $4 - (domain_confidence.corrections + $5) * 1.25)::real
        / NULLIF((domain_confidence.total_actions + $3)::real, 0)
      ))
  `, [tenantId, domain, 1, successInc, correctionInc]);
}
```

The 1.25x correction weight means 5 corrections cancel ~6 successes — biasing the system toward caution without being overly punitive.

### Vibe Subsystem Coordination

The vibe engine coordinates five subsystems, each handling a different aspect of the feedback loop:

```javascript
// vibe/index.js
const subsystems = {
  followUps,        // Schedule and track action outcome checks
  outcomeReactor,   // Auto-resolve follow-ups from events
  knowledgeGaps,    // Detect missing knowledge, generate questions
  synthesizer,      // Infer preferences from behavior patterns
  confidence,       // Domain-level confidence tracking
};

function init() {
  // Only outcome reactor needs explicit init (event subscriptions)
  outcomeReactor.init();
}
```

The synthesizer mines corrections and tool parameter patterns to infer user preferences:

```javascript
// Correction mining: "user corrected date format 4 times → learn preference"
// Tool param analysis: "user always passes format='iso' → default to iso"
// Response pattern mining: "user prefers bullet points over prose"
```

## Implications

- Reactive outcome tracking is more reliable than temporal prediction — it responds to what actually happened, not what might happen
- The 1.25x correction multiplier is configurable, allowing tuning per deployment risk tolerance
- Fire-and-forget confidence recording (`record().catch(() => {})`) means tracking never blocks the response path
- Follow-up delays are deliberately generous — checking too early wastes effort on in-progress work
- Event subscriptions create coupling to specific event sources — adding a new event type requires an outcome reactor handler
- Domain-level confidence (not per-operation) means a bad email experience affects all email operations, which may be too coarse for some use cases

## Code Example

```javascript
// Complete feedback loop: action → follow-up → event → confidence update
// 1. Agent creates a PR
const pr = await tools.execute('create_pr', { repo, title, branch });

// 2. Schedule follow-up to verify outcome
await followUps.schedule({
  action: 'create_pr',
  expectedOutcome: 'merged',
  checkAfter: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
  context: { tenantId, repo, prNumber: pr.number },
});

// 3. Hours later, GitHub webhook fires → outcome reactor resolves
// events.emit('github.pr_merged', { pr: { number: pr.number, repo } })
// → onPrMerged() → resolve follow-up → confidence.record(tenantId, 'code_review', true)

// 4. Confidence score for 'code_review' domain increases
// Future PR actions may auto-execute without approval if confidence > threshold
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Commitment Tracking and Extraction](./commitment-tracking.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Unified Event System](./unified-event-system.md)
