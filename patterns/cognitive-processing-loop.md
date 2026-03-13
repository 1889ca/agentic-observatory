# Cognitive Processing Loop

> Background event-driven processing loop with rule matching and autonomous action dispatch for continuous agent awareness.

## Problem

Agents built on a request-response model only think when a user sends a message. Between messages, the agent is inert — it misses system events, scheduled triggers, activity patterns, and environmental changes. Important signals arrive and decay without ever reaching the agent's reasoning engine. Bolting on individual event handlers creates a fragmented patchwork where each handler has its own logic, no shared context, and no ability to correlate signals across sources.

## Context

- An AI agent or orchestrator that needs continuous awareness beyond user-initiated conversations
- Multiple event sources: system events (file changes, process signals), activity feeds (user behavior, satellite reports), scheduled triggers (cron, timers), external webhooks (GitHub, Slack, monitoring)
- Actions that should fire autonomously when conditions are met, without waiting for user prompting
- Event bursts are common (deploys, batch operations) and must not trigger action storms
- Rules for what constitutes a meaningful signal evolve over time as the agent learns usage patterns

## Solution

### The Cognitive Loop

A background processing loop runs independently of the message-handling path. It continuously ingests events from multiple sources, evaluates them against a rule engine, and dispatches autonomous actions when rules fire.

```
┌──────────────────────────────────────────────┐
│            COGNITIVE LOOP                     │
│                                               │
│  Ingest Events → Buffer → Rule Match →        │
│  Action Dispatch → Observe Outcomes → (loop)  │
│                                               │
│  ┌─ Event sources: system, activity,          │
│  │  scheduled, webhook                        │
│  ├─ Rule engine: static + learned rules       │
│  └─ Debounce layer: collapse bursty signals   │
└──────────────────────────────────────────────┘
```

### Event Ingestion

The loop pulls from a unified event queue fed by multiple producers. Each event has a type, source, and payload:

```javascript
const eventSources = new Map();

function registerSource(name, stream) {
  eventSources.set(name, stream);
  stream.on('event', (event) => {
    eventQueue.push({
      type: event.type,
      source: name,
      payload: event.data,
      timestamp: Date.now()
    });
  });
}

// Register diverse event sources
registerSource('system', systemEventStream);       // Process signals, health checks
registerSource('activity', activityFeed);           // User behavior, satellite reports
registerSource('scheduler', schedulerStream);       // Cron triggers, timer expirations
registerSource('webhooks', webhookIngress);          // External service callbacks
```

### Debounce Layer

A debounce layer sits between ingestion and rule matching. It collapses rapid event bursts into single signals, preventing action storms during high-activity periods like deploys or batch imports:

```javascript
const debounceWindows = new Map();

function debounceEvent(event) {
  const key = `${event.type}:${event.source}`;
  const window = debounceWindows.get(key);

  if (window && Date.now() - window.firstSeen < DEBOUNCE_MS) {
    window.count++;
    window.latest = event;
    return null; // Suppress — will fire when window expires
  }

  // Start new debounce window
  debounceWindows.set(key, {
    firstSeen: Date.now(),
    count: 1,
    latest: event
  });

  // Schedule flush at window expiry
  setTimeout(() => flushDebounceWindow(key), DEBOUNCE_MS);
  return null; // Will fire on flush
}

function flushDebounceWindow(key) {
  const window = debounceWindows.get(key);
  debounceWindows.delete(key);
  if (!window) return;

  // Emit collapsed event with burst metadata
  ruleEngine.evaluate({
    ...window.latest,
    burstCount: window.count,
    burstDuration: Date.now() - window.firstSeen
  });
}
```

### Rule Engine

Rules have two parts: a condition (event type + pattern match) and an action (what to do when the condition is met). Rules can be static (configured by the user or system) or learned (extracted from observed agent behavior patterns):

```javascript
class Rule {
  constructor({ id, name, condition, action, priority = 0, learned = false }) {
    this.id = id;
    this.name = name;
    this.condition = condition;   // Function: (event) => boolean
    this.action = action;         // Function: (event, context) => void
    this.priority = priority;
    this.learned = learned;
    this.fireCount = 0;
    this.lastFired = null;
  }

  matches(event) {
    return this.condition(event);
  }
}

const ruleRegistry = [];

// Static rule: notify on deployment failure
ruleRegistry.push(new Rule({
  id: 'deploy-failure-alert',
  name: 'Alert on deploy failure',
  condition: (event) =>
    event.type === 'webhook.github' &&
    event.payload.action === 'completed' &&
    event.payload.conclusion === 'failure',
  action: (event, ctx) =>
    ctx.dispatch('notify', {
      channel: 'operator',
      message: `Deploy failed: ${event.payload.repository}`
    }),
  priority: 90
}));

// Learned rule: escalate repeated errors
ruleRegistry.push(new Rule({
  id: 'error-escalation',
  name: 'Escalate repeated errors',
  condition: (event) =>
    event.type === 'system.error' && event.burstCount >= 3,
  action: (event, ctx) =>
    ctx.dispatch('triggerFlow', {
      flow: 'error-triage',
      context: { error: event.payload, count: event.burstCount }
    }),
  priority: 80,
  learned: true
}));
```

### Rule Matching and Action Dispatch

Each cognitive cycle evaluates buffered events against all rules, sorted by priority. Matching rules dispatch actions through a unified action handler:

```javascript
class CognitiveEngine {
  constructor(rules, actionHandler) {
    this.rules = rules.sort((a, b) => b.priority - a.priority);
    this.actionHandler = actionHandler;
  }

  evaluate(event) {
    const matchedRules = this.rules.filter(rule => rule.matches(event));

    for (const rule of matchedRules) {
      rule.fireCount++;
      rule.lastFired = Date.now();

      rule.action(event, {
        dispatch: (actionType, payload) =>
          this.actionHandler.handle(actionType, payload, {
            triggeredBy: rule.id,
            event
          })
      });
    }

    return matchedRules.length;
  }
}
```

### Learned Rules

The cognitive loop can observe its own behavior and extract new rules. If a user repeatedly takes the same action in response to the same event pattern, the system proposes a new rule:

```javascript
function analyzePatterns(actionLog) {
  const patterns = {};

  for (const entry of actionLog) {
    const key = `${entry.triggerEvent}→${entry.action}`;
    patterns[key] = patterns[key] || { count: 0, events: [] };
    patterns[key].count++;
    patterns[key].events.push(entry);
  }

  // Propose rules for patterns that occur 5+ times
  return Object.entries(patterns)
    .filter(([, data]) => data.count >= 5)
    .map(([key, data]) => ({
      suggestedRule: key,
      occurrences: data.count,
      examples: data.events.slice(0, 3)
    }));
}
```

## Implications

- The cognitive loop consumes resources continuously — rate limiting and sleep intervals are essential to control compute cost
- Debounce windows introduce latency between event occurrence and rule evaluation — time-critical events may need a bypass path
- Learned rules can drift if behavior patterns change — periodic review and pruning is necessary
- Rule priority ordering means lower-priority rules may never fire during high-activity periods
- Multiple rules matching the same event can produce conflicting actions — conflict resolution logic is needed
- The action dispatch path must be idempotent — duplicate events from retry logic should not produce duplicate actions
- Rule fire counts and timing provide observability, but rule interaction effects are harder to debug
- Static rules give predictability; learned rules give adaptability — the balance depends on operational maturity

## Code Example

```javascript
// Main cognitive processing loop
async function cognitiveLoop(engine, eventQueue) {
  const CYCLE_INTERVAL = 5_000; // 5 seconds between cycles

  while (running) {
    // Drain the event queue
    const events = eventQueue.drain();

    if (events.length === 0) {
      await sleep(CYCLE_INTERVAL);
      continue;
    }

    // Pass each event through debounce, then evaluate
    for (const event of events) {
      debounceEvent(event); // Debounced events reach engine via flush
    }

    // Log cycle stats
    const activeRules = engine.rules.filter(r =>
      r.lastFired && Date.now() - r.lastFired < 60_000
    );
    logger.debug(`Cognitive cycle: ${events.length} events, ${activeRules.length} active rules`);

    await sleep(CYCLE_INTERVAL);
  }
}

// Action handler routes dispatched actions
const actionHandler = {
  handle(actionType, payload, meta) {
    switch (actionType) {
      case 'notify':
        return notificationService.send(payload.channel, payload.message);
      case 'triggerFlow':
        return flowEngine.start(payload.flow, payload.context);
      case 'updateState':
        return stateStore.merge(payload.key, payload.value);
      case 'dispatchWorker':
        return workerPool.submit(payload.task, payload.args);
      default:
        logger.warn(`Unknown action type: ${actionType}`, meta);
    }
  }
};
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
