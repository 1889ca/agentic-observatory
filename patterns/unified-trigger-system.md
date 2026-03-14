# Unified Trigger System

> Polymorphic trigger registry where every automation follows the same event-condition-action structure across all action types.

## Problem

Agent systems accumulate automation pathways organically — a webhook handler here, a cron callback there, an event listener somewhere else. Each pathway has its own interface, error handling, and execution model. A Slack notification fires through a different code path than a tool call, which differs from a job dispatch. This creates inconsistent behavior, duplicate condition-checking logic, and makes it nearly impossible to compose automations. Adding a new automation type requires touching multiple subsystems instead of registering a single trigger.

## Context

- An orchestrator that reacts to events with diverse action types: notifications, tool calls, job dispatch, approval workflows, delayed execution, chained automations
- Automations are created by both system configuration and user requests at runtime
- Some automations need to chain — the output of one trigger feeds the input of another
- Actions have different reliability requirements (notifications are fire-and-forget, approvals block until resolved)
- The number of automation types grows over time as the system gains capabilities

## Solution

### The Trigger Model

Every automation in the system follows a single structure: an event condition paired with an action. The trigger registry stores, matches, and dispatches all automations regardless of action type.

```javascript
// Universal trigger structure
{
  id: 'trigger-uuid',
  name: 'Human-readable name',
  event: {
    type: 'webhook.github',         // Event type to match
    filter: { action: 'push' }      // Optional payload filter
  },
  condition: 'payload.branch === "main"',  // Optional guard expression
  action: {
    type: 'NOTIFY',                  // Action type (polymorphic)
    config: {                        // Type-specific configuration
      channel: 'telegram',
      message: 'Push to main: {{payload.commits.length}} commits'
    }
  },
  enabled: true,
  createdAt: '2026-03-01T00:00:00Z'
}
```

### Action Types

The system provides a fixed set of polymorphic action types. Each type has its own executor but shares the same trigger lifecycle:

```javascript
const ACTION_TYPES = {
  // Send a message to a notification channel
  NOTIFY: {
    execute: async (config, context) => {
      const message = interpolate(config.message, context);
      return channels.send(config.channel, message);
    }
  },

  // Call a registered tool or capability
  TOOL: {
    execute: async (config, context) => {
      const args = interpolate(config.args, context);
      return capabilities.execute(config.tool, args);
    }
  },

  // Dispatch an async worker job
  JOB: {
    execute: async (config, context) => {
      return jobQueue.submit({
        type: config.jobType,
        payload: interpolate(config.payload, context),
        priority: config.priority || 'normal'
      });
    }
  },

  // Trigger another automation (chaining)
  CHAIN: {
    execute: async (config, context) => {
      const nextTrigger = triggerRegistry.get(config.triggerId);
      return dispatchAction(nextTrigger.action, {
        ...context,
        chainedFrom: context.triggerId
      });
    }
  },

  // Schedule deferred execution
  DELAY: {
    execute: async (config, context) => {
      return scheduler.defer({
        action: config.deferredAction,
        context,
        executeAt: Date.now() + parseDuration(config.delay)
      });
    }
  },

  // Gate on human confirmation before proceeding
  APPROVAL: {
    execute: async (config, context) => {
      const approval = await approvalQueue.request({
        prompt: interpolate(config.prompt, context),
        channel: config.channel,
        timeout: config.timeout || 3600_000,
        onApprove: config.onApprove,   // Action to execute if approved
        onDeny: config.onDeny          // Action to execute if denied
      });
      return approval;
    }
  }
};
```

### Trigger Registry

All triggers live in a single registry backed by persistent storage. The registry supports CRUD operations and event matching:

```javascript
class TriggerRegistry {
  constructor(store) {
    this.store = store;    // Database-backed persistence
    this.cache = new Map(); // In-memory index by event type
  }

  async register(trigger) {
    await this.store.insert(trigger);
    this.indexByEventType(trigger);
    return trigger;
  }

  async update(id, changes) {
    const trigger = await this.store.update(id, changes);
    this.reindex(trigger);
    return trigger;
  }

  async remove(id) {
    await this.store.delete(id);
    this.removeFromIndex(id);
  }

  // Find all triggers that match an incoming event
  match(event) {
    const candidates = this.cache.get(event.type) || [];
    return candidates.filter(trigger => {
      if (!trigger.enabled) return false;

      // Check payload filter
      if (trigger.event.filter) {
        for (const [key, value] of Object.entries(trigger.event.filter)) {
          if (event.payload[key] !== value) return false;
        }
      }

      // Evaluate guard condition
      if (trigger.condition) {
        return evaluateCondition(trigger.condition, { payload: event.payload });
      }

      return true;
    });
  }

  indexByEventType(trigger) {
    const list = this.cache.get(trigger.event.type) || [];
    list.push(trigger);
    this.cache.set(trigger.event.type, list);
  }
}
```

### Event Matching and Dispatch

When an event arrives, the system finds matching triggers and dispatches their actions:

```javascript
async function processEvent(event, registry) {
  const triggers = registry.match(event);

  const results = [];
  for (const trigger of triggers) {
    const context = {
      triggerId: trigger.id,
      event,
      payload: event.payload,
      timestamp: Date.now()
    };

    const result = await dispatchAction(trigger.action, context);
    results.push({ triggerId: trigger.id, result });

    // Record execution for audit
    await auditLog.record({
      triggerId: trigger.id,
      event: event.type,
      actionType: trigger.action.type,
      result,
      timestamp: Date.now()
    });
  }

  return results;
}

async function dispatchAction(action, context) {
  const executor = ACTION_TYPES[action.type];
  if (!executor) {
    throw new Error(`Unknown action type: ${action.type}`);
  }

  return executor.execute(action.config, context);
}
```

### Template Interpolation

Action configs support template strings that reference event payloads and context:

```javascript
function interpolate(template, context) {
  if (typeof template === 'string') {
    return template.replace(/\{\{(.+?)\}\}/g, (_, path) => {
      return getNestedValue(context, path.trim());
    });
  }

  if (typeof template === 'object' && template !== null) {
    const result = Array.isArray(template) ? [] : {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = interpolate(value, context);
    }
    return result;
  }

  return template;
}
```

### Composability via Chaining

Triggers can chain into each other, creating complex workflows from simple building blocks. A deploy pipeline expressed as chained triggers:

```javascript
// Trigger 1: On push to main, run tests
await registry.register({
  id: 'deploy-step-1',
  name: 'Run tests on push to main',
  event: { type: 'webhook.github', filter: { action: 'push' } },
  condition: 'payload.branch === "main"',
  action: {
    type: 'JOB',
    config: { jobType: 'run-tests', payload: { repo: '{{payload.repository}}' } }
  }
});

// Trigger 2: On test success, request deploy approval
await registry.register({
  id: 'deploy-step-2',
  name: 'Request deploy approval',
  event: { type: 'job.completed', filter: { jobType: 'run-tests' } },
  condition: 'payload.status === "success"',
  action: {
    type: 'APPROVAL',
    config: {
      prompt: 'Tests passed for {{payload.repo}}. Deploy to production?',
      channel: 'telegram',
      onApprove: { type: 'CHAIN', config: { triggerId: 'deploy-step-3' } },
      onDeny: { type: 'NOTIFY', config: { channel: 'telegram', message: 'Deploy cancelled.' } }
    }
  }
});

// Trigger 3: Execute deploy
await registry.register({
  id: 'deploy-step-3',
  name: 'Deploy to production',
  event: { type: 'manual' }, // Only fired via chain
  action: {
    type: 'TOOL',
    config: { tool: 'deploy', args: { env: 'production' } }
  }
});
```

## Implications

- The polymorphic action model is only as expressive as its action types — new automation patterns require adding new types to the registry
- Chained triggers can create cycles if not validated at registration time — cycle detection is essential
- Guard condition evaluation uses dynamic expression parsing, which needs sandboxing to prevent injection
- APPROVAL actions block their chain until a human responds — timeouts and fallback actions are necessary
- DELAY actions require durable scheduling that survives process restarts — in-memory timers are insufficient
- Template interpolation on untrusted payloads is an injection vector — sanitization is required
- A single event can match multiple triggers, and their actions may conflict — ordering and deduplication strategies are needed
- Audit logging every trigger execution generates significant write volume — retention policies and sampling may be necessary
- The unified model trades some type-specific optimization for consistency — a dedicated webhook handler could be faster than routing through the generic trigger pipeline

## Code Example

```javascript
// API layer for trigger management
const triggerAPI = {
  // Create a new trigger
  async create(req) {
    const trigger = {
      id: generateId(),
      name: req.name,
      event: req.event,
      condition: req.condition || null,
      action: req.action,
      enabled: true,
      createdAt: new Date().toISOString()
    };

    // Validate action type exists
    if (!ACTION_TYPES[trigger.action.type]) {
      throw new Error(`Invalid action type: ${trigger.action.type}`);
    }

    // Check for chain cycles
    if (trigger.action.type === 'CHAIN') {
      detectCycles(trigger, registry);
    }

    return registry.register(trigger);
  },

  // List triggers, optionally filtered by event type
  async list(eventType) {
    const all = await registry.store.getAll();
    return eventType
      ? all.filter(t => t.event.type === eventType)
      : all;
  },

  // Toggle trigger on/off
  async toggle(id) {
    const trigger = await registry.store.get(id);
    return registry.update(id, { enabled: !trigger.enabled });
  },

  // Delete a trigger
  async remove(id) {
    // Check for inbound chains referencing this trigger
    const dependents = await findDependents(id, registry);
    if (dependents.length > 0) {
      throw new Error(
        `Cannot delete: referenced by ${dependents.map(d => d.name).join(', ')}`
      );
    }
    return registry.remove(id);
  }
};
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Unified Event System](./unified-event-system.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
