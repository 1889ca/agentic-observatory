# Unified Trigger System

> Plain event bus with namespaced events and subscriber management for decoupled inter-module communication.

## Problem

An agent system has many modules that need to communicate: the cognitive processor emits events that the outbound queue needs to hear, webhook arrivals need to reach the rule engine, and task completions need to update the UI. Without a shared communication layer, modules import each other directly, creating circular dependencies and tight coupling. Adding a new consumer for an existing event means modifying the producer.

## Context

- An orchestrator with many loosely-coupled modules that react to shared events
- Events originate from diverse sources: webhooks, timers, user messages, internal state changes
- Multiple subscribers may need to react to the same event
- Modules should be addable without modifying existing producers
- No need for persistence, chaining, or complex action dispatch — just in-process event routing

## Solution

### EventEmitter-Based Bus

The unified event system is a plain EventEmitter-style bus. Modules emit events with a namespaced type string, and any number of subscribers can listen:

```javascript
// unified-events.js
const EventEmitter = require('events');

class UnifiedEvents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  publish(namespace, eventName, payload) {
    const type = `${namespace}:${eventName}`;
    this.emit(type, { type, payload, timestamp: Date.now() });
  }

  subscribe(namespace, eventName, handler) {
    const type = `${namespace}:${eventName}`;
    this.on(type, handler);
    return () => this.off(type, handler);
  }
}
```

### Namespaced Events

Events use a `namespace:event` convention to avoid collisions and make it clear where events originate:

```
webhook:github.push
task:completed
cognitive:rule-matched
session:started
session:ended
channel:message-received
```

### Subscriber Management

Subscribers register during module initialization and receive an unsubscribe function for clean teardown:

```javascript
// Example: outbound queue subscribes to notification events
function initOutboundQueue(events) {
  const unsubs = [
    events.subscribe('cognitive', 'notification', onNotification),
    events.subscribe('task', 'completed', onTaskCompleted),
    events.subscribe('webhook', 'received', onWebhookReceived),
  ];

  return {
    shutdown() {
      unsubs.forEach(fn => fn());
    }
  };
}
```

### Singleton Bus

A single bus instance is shared across the application. Modules import it and publish or subscribe without knowing about each other:

```javascript
// Shared instance
const events = new UnifiedEvents();
module.exports = events;

// Producer (webhook handler)
events.publish('webhook', 'github.push', { repo, commits });

// Consumer (cognitive processor)
events.subscribe('webhook', 'github.push', async (event) => {
  await insertCognitiveEvent('webhook:github.push', event.payload);
});
```

## Implications

- The bus is in-process only — events do not survive restarts and are not persisted
- No ordering guarantees between subscribers listening to the same event
- Namespacing is a convention, not enforced — typos in event names fail silently with no subscribers
- No built-in retry, backpressure, or dead-letter handling — subscribers that throw will emit an `error` event on the bus
- Adding a new event consumer requires zero changes to the producer — just subscribe to the type string
- The bus is synchronous fan-out by default (EventEmitter behavior) — long-running handlers should defer work to avoid blocking other subscribers

## Code Example

```javascript
// Module initialization wiring the event bus
const events = require('./unified-events');

// Webhook handler publishes
app.post('/webhook/github', (req, res) => {
  events.publish('webhook', 'github.push', req.body);
  res.sendStatus(200);
});

// Cognitive processor subscribes
events.subscribe('webhook', 'github.push', async ({ payload }) => {
  await queueCognitiveEvent('webhook:push', payload);
});

// Activity tracker also subscribes (independent)
events.subscribe('webhook', 'github.push', async ({ payload }) => {
  await logActivity('github-push', payload.repository);
});
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Unified Event System](./unified-event-system.md)
- [Webhook Event Bridge](./webhook-event-bridge.md)
