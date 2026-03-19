# Declarative Capability System

> Four-tier capability model (tools, skills, reflexes, workflows) with JSON Schema declarations and string-based autonomy tiers for LLM-native tool use.

## Problem

An AI orchestrator needs to do many things — CRUD entities, search memory, dispatch jobs, interact with external services. Hard-coding these capabilities creates a brittle, monolithic system where adding a new action requires modifying the core message loop. Worse, the LLM needs to know what actions are available, and imperative code doesn't self-describe.

## Context

- An LLM-powered orchestrator that dispatches actions via tool calls
- Multiple capability types with different execution semantics
- Need for runtime capability discovery (plugins, per-project tools)
- Autonomy tiers that gate which capabilities can auto-execute
- Error recovery requirements vary by capability type

## Solution

### Four Capability Tiers

Capabilities are organized into four tiers with increasing complexity:

**Tools** — Atomic primitives. Each tool is a JSON Schema declaration that the LLM can invoke directly. Tools are the building blocks; everything else composes them.

```javascript
// Tool declaration — LLM sees this as an available function
{
  name: 'entity',
  description: 'Create, read, update, or delete entities',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'read', 'update', 'delete'] },
      entityType: { type: 'string' },
      data: { type: 'object' },
    },
  },
}
```

**Skills** — Composable workflows built on tools. A skill chains multiple tool calls into a higher-level operation. The LLM invokes the skill; the skill orchestrates the tools internally.

**Reflexes** — Triggered automations. A reflex defines a condition and a tool execution. When the condition matches an incoming event, the reflex fires without LLM involvement. Useful for routine reactions (e.g., auto-tag incoming messages by channel).

**Workflows** — Multi-step orchestrations with error handling and branching. Workflows define a DAG of steps, each producing output that feeds the next. Failed steps trigger recovery logic rather than aborting the entire flow.

### String-Based Autonomy Tiers

Each capability declares an autonomy tier using string constants rather than numeric levels. This makes the semantics explicit:

```javascript
const AUTONOMY_TIERS = {
  AUTO: 'AUTO',      // Execute automatically, no notification
  NOTIFY: 'NOTIFY',  // Execute and notify the user afterward
  ASK: 'ASK',        // Ask for approval before executing
  NEVER: 'NEVER',    // Never auto-execute, always require explicit invocation
};
```

Before execution, the system checks the capability's tier:

```javascript
async function executeTool(name, params, userId) {
  const tool = registry.get(name);

  switch (tool.autonomyTier) {
    case 'AUTO':
      return await tool.execute(params);
    case 'NOTIFY':
      const result = await tool.execute(params);
      await notify(userId, `Executed ${name}`, result);
      return result;
    case 'ASK':
      return await requestApproval(userId, name, params);
    case 'NEVER':
      throw new Error(`${name} requires explicit invocation`);
  }
}
```

### Lazy Initialization

Capabilities are not loaded at startup. On the first incoming message, the registry initializes:

```javascript
async function ensureCapabilities() {
  if (initialized) return;
  await capabilities.init();
  declarations = capabilities.getDeclarations();
  initialized = true;
}
```

This avoids wasting startup time on capabilities that may never be used in a short-lived session, and ensures plugins are fully loaded before declarations are built.

### Tool Aliases

When tools are renamed or deprecated, aliases provide graceful fallback:

```javascript
// If the LLM calls a deprecated name, resolve to the current tool
const resolved = aliases.get(toolName) || toolName;
```

This prevents breaking existing skills and reflexes that reference old tool names.

## Implications

- Adding a capability requires only a declaration file — no changes to the message loop
- The LLM sees all available actions as a flat tool list, regardless of whether they're tools, skills, or reflexes under the hood
- String-based tiers (`AUTO`/`NOTIFY`/`ASK`/`NEVER`) are more readable and less error-prone than numeric levels (1-4)
- Lazy loading means first-message latency includes capability init
- Autonomy gating adds a decision point to every tool execution
- Aliases accumulate technical debt if old names are never fully migrated

## Code Example

```javascript
// Capability execution with autonomy gating and error recovery
async function execute(toolName, params, userId) {
  await ensureCapabilities();
  const tool = registry.resolve(toolName); // Handles aliases

  // Autonomy check
  if (tool.autonomyTier === 'ASK') {
    const approved = await requestApproval(userId, toolName, params);
    if (!approved) return { status: 'denied' };
  }

  try {
    const result = await tool.execute(params);
    if (tool.autonomyTier === 'NOTIFY') {
      notify(userId, toolName, result).catch(() => {});
    }
    return result;
  } catch (err) {
    if (isRetryable(err)) {
      return await retryWithBackoff(tool, params);
    }
    throw err;
  }
}
```

## Relationship to Capability Manifest Registration

This pattern and [Capability Manifest Registration](./capability-manifest-registration.md) document different aspects of Riley's unified `lib/capabilities/` system:

- **Declarative Capability System (this pattern)** — Describes the four-tier capability model (tools, skills, reflexes, workflows), string-based autonomy tiers (AUTO/NOTIFY/ASK/NEVER), and how capabilities self-describe via JSON Schema for LLM consumption.
- **Capability Manifest Registration** — Describes the runtime registry mechanics: Map-based tool lookup, entity type resolution with aliases, and widget type mapping.

In practice, the declarative system defines _what_ capabilities are and how they're gated, while the manifest registration handles _how_ they're stored, resolved, and looked up at runtime.

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
