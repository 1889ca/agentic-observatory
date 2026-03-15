# Autonomous Agent Cycle

> Event-driven cognitive tick system with adaptive backpressure, priority-based event processing, and DB-backed outbound queue for autonomous agent behavior.

## Problem

An AI orchestrator that only responds to user messages is reactive — it waits idle between interactions. But a capable system should proactively process events, triage incoming work, and maintain situational awareness. A continuous scan-strategy-execute loop wastes compute when idle and can't adapt to load. What's needed is an event-driven system with backpressure that processes autonomously while staying responsive.

## Context

- An orchestrator with access to project state, event queues, and external services
- Events arrive at variable rates — bursty during work hours, quiet overnight
- Processing must respect per-tenant fairness and avoid starvation
- Autonomous processing must not interfere with interactive user requests
- Need for notification-mode awareness (silent mode should only process critical items)

## Solution

### Event-Driven Tick System

Instead of continuously scanning for work, the cognitive processor runs on a configurable tick interval (default 5 seconds). Each tick processes a batch of pending events from a database-backed queue:

```javascript
// cognitive/processor.js
let isProcessing = false;

async function tick(options = {}) {
  if (isProcessing) {
    // Backpressure: skip this tick if previous is still running
    return;
  }

  isProcessing = true;
  const tickStart = Date.now();

  try {
    const mode = await contextBehaviors.getNotificationMode();

    if (mode === 'silent') {
      // Silent mode: only process high-priority events (priority >= 8)
      await processEvents({ ...options, minPriority: 8 });
    } else {
      await processEvents(options);
    }
  } finally {
    isProcessing = false;
    const tickDuration = Date.now() - tickStart;
    if (tickDuration > 1000) {
      logger.debug({ tickDurationMs: tickDuration }, 'Tick slow');
    }
  }
}
```

### Adaptive Backpressure

When ticks consistently exceed their time budget, the system reduces batch size to maintain throughput:

```javascript
let batchSize = 20;
let consecutiveSlowTicks = 0;

function adjustBackpressure(tickDuration) {
  if (tickDuration > 1000) {
    consecutiveSlowTicks++;
    if (consecutiveSlowTicks >= 3) {
      // Reduce batch size by half, minimum 5
      batchSize = Math.max(5, Math.floor(batchSize * 0.5));
      consecutiveSlowTicks = 0;
    }
  } else {
    consecutiveSlowTicks = 0;
    // Gradually recover batch size
    batchSize = Math.min(20, batchSize + 1);
  }
}
```

### DB-Backed Event Queue with Atomic Claiming

Events are stored in a database table. Processing uses `FOR UPDATE SKIP LOCKED` to prevent duplicate processing across instances:

```javascript
async function processEvents(options = {}) {
  const { minPriority = 0 } = options;

  // Atomic claim: lock rows to prevent duplicate processing
  const events = await db.query(`
    SELECT * FROM cognitive_events
    WHERE status = 'pending'
      AND priority >= $1
    ORDER BY priority DESC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  `, [minPriority, batchSize]);

  for (const event of events) {
    await processEvent(event);
    await db.query(
      `UPDATE cognitive_events SET status = 'processed' WHERE id = $1`,
      [event.id]
    );
  }
}
```

### Per-Tenant Fairness

A per-tenant limit prevents one noisy tenant from starving others in multi-tenant deployments:

```javascript
const perTenantLimit = Math.max(3, Math.floor(batchSize / tenantCount));

// Group events by tenant, cap each tenant's batch
const byTenant = groupBy(events, 'tenant_id');
const fairBatch = Object.values(byTenant)
  .flatMap(tenantEvents => tenantEvents.slice(0, perTenantLimit));
```

### DB-Backed Outbound Queue

Autonomous actions that produce messages (notifications, alerts, follow-ups) go through a persistent outbound queue rather than sending directly:

```javascript
// outbound-queue.js
async function enqueue(channel, content, options = {}) {
  await db.query(`
    INSERT INTO outbound_queue (channel, content, status, priority, deliver_at)
    VALUES ($1, $2, 'pending', $3, $4)
  `, [channel, content, options.priority || 5, options.deliverAt || new Date()]);
}

async function process() {
  const pending = await db.query(`
    SELECT * FROM outbound_queue
    WHERE status = 'pending' AND deliver_at <= NOW()
    FOR UPDATE SKIP LOCKED
    LIMIT 10
  `);

  for (const item of pending) {
    if (!isChannelConnected(item.channel)) {
      // Channel offline — restore to pending, don't lose the message
      continue;
    }
    await sendViaChannel(item.channel, item.content);
    await markSent(item.id);
  }
}
```

### Startup Sequence

The cognitive system starts in a specific order — producers seed initial events, then the processor begins ticking:

```javascript
// Contract: startAll() seeds rules, starts processor, then producers
async function startAll({ tickInterval = 5000, timezone }) {
  await seedRules();                    // Load cognitive rules
  startProcessor(tickInterval);         // Begin tick loop
  await startProducers();               // Begin event generation
}

// Shutdown reverses the order
async function stopAll() {
  stopProcessor();                      // Stop consuming first
  await stopProducers();                // Then stop producing
}
```

## Implications

- The tick-based model has bounded latency (worst case = tick interval) unlike continuous loops that can spin
- `FOR UPDATE SKIP LOCKED` enables horizontal scaling — multiple processor instances can safely share the queue
- Backpressure prevents cascading slowdowns — the system gracefully degrades under load instead of falling behind
- Silent mode filtering means the user can mute non-critical autonomous behavior without stopping the system
- Per-tenant fairness adds slight overhead but prevents pathological starvation in multi-tenant scenarios
- The outbound queue decouples message generation from delivery, surviving channel disconnections

## Code Example

```javascript
// Complete cognitive system lifecycle
const cognitive = {
  async startAll({ tickInterval = 5000 }) {
    // 1. Seed cognitive rules from config
    await seedRules();

    // 2. Start the processor tick loop
    this.timer = setInterval(() => tick(), tickInterval);

    // 3. Start producers (event generators)
    await Promise.allSettled(
      producers.map(p => p.start())
    );
  },

  async stopAll() {
    clearInterval(this.timer);
    await Promise.allSettled(
      producers.map(p => p.stop())
    );
  },
};

// Usage in main application startup
if (RUN_COGNITIVE) {
  await cognitive.startAll({
    tickInterval: parseInt(process.env.COGNITIVE_TICK_INTERVAL || '5000'),
  });
}
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
