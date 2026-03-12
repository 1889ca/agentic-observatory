# Declarative Capability System

> Four-tier capability model (tools, skills, reflexes, workflows) with JSON Schema declarations for LLM-native tool use.

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
      data: { type: 'object' }
    }
  }
}
```

**Skills** — Composable workflows built on tools. A skill chains multiple tool calls into a higher-level operation. The LLM invokes the skill; the skill orchestrates the tools internally.

**Reflexes** — Triggered automations. A reflex defines a condition and a tool execution. When the condition matches an incoming event, the reflex fires without LLM involvement. Useful for routine reactions (e.g., auto-tag incoming messages by channel).

**Workflows** — Multi-step orchestrations with error handling and branching. Workflows define a DAG of steps, each producing output that feeds the next. Failed steps trigger recovery logic rather than aborting the entire flow.

### Lazy Initialization

Capabilities are not loaded at startup. On the first incoming message, the registry initializes:

```javascript
async function ensureCapabilities() {
  if (initialized) return;
  await capabilities.init();          // Load tools, skills, reflexes, workflows
  declarations = capabilities.getDeclarations(); // 225+ tool declarations
  initialized = true;
}
```

This avoids wasting startup time on capabilities that may never be used in a short-lived session, and ensures plugins are fully loaded before declarations are built.

### Autonomy Gating

Each tool can declare an autonomy tier (1–4). Before execution, the system checks whether the current autonomy level permits the action:

```javascript
async function executeTool(name, params) {
  const tool = registry.get(name);
  if (tool.tier > currentAutonomyLevel) {
    return await requestApproval(name, params);
  }
  return await tool.execute(params);
}
```

Tier 1 actions (read-only, status checks) always run. Tier 4 actions (destructive, external-facing) require explicit human approval.

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
- Lazy loading means first-message latency includes capability init
- Autonomy gating adds a decision point to every tool execution
- The declaration count (225+) approaches LLM context limits for tool-heavy dispatches
- Aliases accumulate technical debt if old names are never fully migrated

## Code Example

```javascript
// Capability execution with error triage
async function execute(toolName, params) {
  await ensureCapabilities();
  const tool = registry.resolve(toolName); // Handles aliases

  try {
    return await tool.execute(params);
  } catch (err) {
    const category = triageError(err); // protocol | transient | runtime
    if (category === 'transient') {
      return await retryWithBackoff(tool, params);
    }
    if (category === 'runtime') {
      return await attemptRecovery(tool, params, err);
    }
    throw err; // Protocol errors are unrecoverable
  }
}
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
