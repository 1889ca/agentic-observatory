# Worker Permission Escalation

> Static string-based autonomy tiers per capability, where each tool declares its permission level (AUTO/NOTIFY/ASK/NEVER) and the system routes accordingly.

## Problem

When a worker agent needs to perform an action, the system needs a clear permission model. Without one, every tool call requires either blanket approval (risky) or human confirmation (slow). The system needs a structured permission scheme that's predictable, auditable, and doesn't require runtime scoring to determine what's allowed.

## Context

- Workers executing tool calls with varying levels of risk and reversibility
- A capability registry where each tool has a declared autonomy tier
- Four permission levels that cover the full spectrum from safe to forbidden
- The need for deterministic, predictable permission routing — not probabilistic scoring
- Permission levels are set at registration time, not computed at runtime

## Solution

### Static Autonomy Tiers per Capability

Each capability declares one of four string-based autonomy tiers. The tier is a static property of the tool definition, not a runtime calculation:

```javascript
// Autonomy tier strings
const AUTONOMY_TIERS = {
  AUTO: 'AUTO',     // Execute without any notification
  NOTIFY: 'NOTIFY', // Execute and notify the user afterward
  ASK: 'ASK',       // Queue for user approval before executing
  NEVER: 'NEVER',   // Never execute — blocked entirely
};
```

### Permission Routing

When a worker dispatches a tool call, the system reads the tool's declared tier and routes accordingly:

```javascript
async function gateWorkerAction(toolName, args) {
  const tool = registry.get(toolName);
  const tier = tool.autonomyTier; // Static string: AUTO | NOTIFY | ASK | NEVER

  switch (tier) {
    case 'AUTO':
      return await executeTool(toolName, args);

    case 'NOTIFY':
      const result = await executeTool(toolName, args);
      await notify(tool.owner, `Executed ${toolName}`, result);
      return result;

    case 'ASK':
      return await addToApprovalQueue({
        tool: toolName,
        args,
        reason: 'Tool requires explicit approval',
      });

    case 'NEVER':
      return { blocked: true, reason: `${toolName} is permanently blocked` };
  }
}
```

### Tier Assignment at Registration

Tools declare their tier when registered. The tier reflects the tool's inherent risk level:

```javascript
// Tool registration with autonomy tier
registry.register({
  name: 'run-tests',
  autonomyTier: 'AUTO',       // Safe, reversible — auto-execute
  handler: runTests,
});

registry.register({
  name: 'deploy-staging',
  autonomyTier: 'NOTIFY',     // Execute but tell the user
  handler: deployStagingHandler,
});

registry.register({
  name: 'deploy-production',
  autonomyTier: 'ASK',        // Needs human approval
  handler: deployProductionHandler,
});

registry.register({
  name: 'delete-database',
  autonomyTier: 'NEVER',      // Hard block — never allowed
  handler: null,
});
```

### Safe Defaults

If a tool has no declared tier, the system defaults to ASK:

```javascript
function getTier(toolName) {
  const tool = registry.get(toolName);
  return tool?.autonomyTier || 'ASK'; // Unknown tools require approval
}
```

## Implications

- Permission decisions are deterministic and auditable — the tier is visible in the tool definition, not buried in a scoring algorithm
- No runtime latency for permission checks — it's a string lookup, not a model call or vote
- Tier changes require updating the tool registration, not retraining a scoring model
- The system cannot adapt autonomy based on context or track record — a NOTIFY tool is always NOTIFY regardless of how reliably the agent uses it
- NEVER tier provides a hard block that no confidence score or voting mechanism can override
- The simplicity of string tiers trades flexibility for predictability

## Code Example

```javascript
// Worker dispatch with static tier gating
async function dispatchWorkerTask(task) {
  const tools = task.requiredTools || [];

  for (const toolName of tools) {
    const tier = getTier(toolName);

    if (tier === 'NEVER') {
      return { blocked: true, tool: toolName };
    }

    if (tier === 'ASK') {
      return await addToApprovalQueue({
        task: task.id,
        tool: toolName,
        reason: 'Tool tier requires approval',
      });
    }
  }

  // All tools are AUTO or NOTIFY — execute the task
  const result = await executeTask(task);

  // Notify for any NOTIFY-tier tools used
  const notifyTools = tools.filter(t => getTier(t) === 'NOTIFY');
  if (notifyTools.length > 0) {
    await notify(task.owner, `Task ${task.id} used: ${notifyTools.join(', ')}`, result);
  }

  return result;
}
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
