# Autonomous Agent Cycle

> Queue-based cognitive processor with rule matching for continuous autonomous event processing, paired with a periodic objectives review loop for goal tracking.

## Problem

An AI orchestrator that only responds to user messages is reactive — it waits idle between interactions. But a capable system should proactively process events, triage incoming work, and maintain situational awareness. A continuous scan-strategy-execute loop wastes compute when idle and can't adapt to load. What's needed is a queue-based system that processes events through rule matching while staying responsive to interactive requests.

## Context

- An orchestrator with access to project state, event queues, and external services
- Events arrive at variable rates — bursty during work hours, quiet overnight
- Processing must not interfere with interactive user requests
- Rules define how events are matched and what actions to dispatch
- A separate, slower loop periodically reviews high-level objectives

## Solution

### Queue-Based Cognitive Processor

The cognitive processor runs on a configurable tick interval (default 5 seconds). Each tick pulls pending events from a DB-backed queue and matches them against loaded rules:

```javascript
// cognitive/processor.js
let isProcessing = false;

async function tick() {
  if (isProcessing) return; // Backpressure: skip if previous tick is running

  isProcessing = true;
  try {
    const events = await db.query(`
      SELECT * FROM cognitive_events
      WHERE status = 'pending'
      ORDER BY priority DESC
      LIMIT $1
    `, [batchSize]);

    for (const event of events) {
      const rule = matchRule(event);
      if (rule) await rule.action(event);
      await markProcessed(event.id);
    }
  } finally {
    isProcessing = false;
  }
}
```

### Rule Matching

Rules are seeded at startup from configuration. Each rule declares a condition function and an action to execute when matched. Events are tested against rules in priority order:

```javascript
// cognitive/rules.js
const rules = [];

function seedRules() {
  rules.push(
    { name: 'commitment-overdue', test: e => e.type === 'commitment:overdue', action: notifyOverdue },
    { name: 'task-stalled', test: e => e.type === 'task:stalled', action: escalateTask },
    { name: 'webhook-received', test: e => e.type.startsWith('webhook:'), action: routeWebhook },
  );
}

function matchRule(event) {
  return rules.find(r => r.test(event));
}
```

### Periodic Objectives Review

Separate from the fast cognitive tick, a simpler periodic loop checks active objectives. This runs on a longer interval (e.g., every 2 hours) and generates cognitive events if objectives are stalled or completed:

```javascript
// agent/cycle.js
async function objectivesReview() {
  const objectives = await db.query(
    `SELECT * FROM objectives WHERE status = 'active'`
  );

  for (const obj of objectives) {
    if (isStalled(obj)) {
      await insertCognitiveEvent('objective:stalled', { objectiveId: obj.id });
    }
    if (isComplete(obj)) {
      await db.query(`UPDATE objectives SET status = 'completed' WHERE id = $1`, [obj.id]);
    }
  }
}
```

### Startup and Shutdown

The cognitive system starts in a specific order — rules are seeded first, then both loops begin:

```javascript
async function startAll({ tickInterval = 5000 }) {
  await seedRules();
  const tickTimer = setInterval(() => tick(), tickInterval);
  const reviewTimer = setInterval(objectivesReview, 2 * 60 * 60 * 1000);

  return {
    stop() {
      clearInterval(tickTimer);
      clearInterval(reviewTimer);
    }
  };
}
```

## Implications

- The tick-based model has bounded latency (worst case = tick interval) unlike continuous loops that can spin
- Backpressure prevents cascading slowdowns — the system skips ticks rather than falling behind
- Rule matching is simple function evaluation, keeping per-event overhead low
- Events that match no rule are still marked processed — unmatched events don't accumulate
- The objectives review is intentionally simple: check status, emit events. Strategic planning happens elsewhere
- Adding new autonomous behaviors means adding rules, not modifying the processor

## Code Example

```javascript
// Complete cognitive system lifecycle
if (process.env.RUN_COGNITIVE) {
  const system = await startAll({
    tickInterval: parseInt(process.env.COGNITIVE_TICK_INTERVAL || '5000'),
  });

  process.on('SIGTERM', () => system.stop());
}
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
