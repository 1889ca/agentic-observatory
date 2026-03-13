# Capability Manifest Registration

> Declarative capability registration so an orchestrator can discover and dispatch tools, skills, and workflows without hardcoding.

## Problem

An orchestrator managing multiple tools and workflows needs to know what's available — which actions it can take, what parameters they require, and how to invoke them. Hardcoding capabilities in the orchestrator creates tight coupling: adding a new capability means editing core orchestrator code. As the system grows, the mapping between "what the user wants" and "what the system can do" becomes a sprawling switch statement that's impossible to maintain.

## Context

- An orchestrator that dispatches work across multiple tools, skills, or workflows
- Capabilities evolve over time — new ones are added, old ones are deprecated
- Each capability has different parameter requirements, invocation methods, and output formats
- Need for the orchestrator to reason about available capabilities at runtime (e.g., for AI-driven tool selection)
- Implementation can be internal (programmatic registration at startup) or external (config files discovered from project directories) — the pattern applies to both

## Solution

### Capability Registry

A central registry where capabilities are declared with structured metadata. Each capability entry describes what it does, what inputs it accepts (via JSON Schema), and how to invoke it:

```javascript
const registry = new Map();

function registerCapability(capability) {
  const { name, tier, description, schema, handler } = capability;
  registry.set(name, { name, tier, description, schema, handler });
}

// Registration at startup
registerCapability({
  name: 'search-docs',
  tier: 'tool',          // direct invocation
  description: 'Search documentation across all knowledge bases',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      scope: { type: 'string', enum: ['all', 'project', 'global'] }
    },
    required: ['query']
  },
  handler: async (params) => searchDocs(params.query, params.scope)
});
```

### Tiered Capability Model

Capabilities are organized into tiers based on their complexity and invocation pattern:

- **Tools**: Direct, stateless operations (search, lookup, calculate). Invoked synchronously, return a result.
- **Skills**: Multi-step operations with internal logic (code review, deployment). May invoke multiple tools.
- **Reflexes**: Automatic triggers fired by events (new commit, error detected). No explicit invocation.
- **Workflows**: Orchestrated multi-step pipelines with human checkpoints, branching, and state persistence.

```javascript
function getCapabilitiesByTier(tier) {
  return [...registry.values()].filter(cap => cap.tier === tier);
}

// AI model can reason about available tools
function getToolDescriptions() {
  return getCapabilitiesByTier('tool').map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.schema
  }));
}
```

### Discovery and Dispatch

The orchestrator queries the registry to find matching capabilities and dispatches to the appropriate handler:

```javascript
async function dispatch(capabilityName, params) {
  const cap = registry.get(capabilityName);
  if (!cap) throw new Error(`Unknown capability: ${capabilityName}`);

  // Validate params against JSON Schema
  const valid = validate(params, cap.schema);
  if (!valid) throw new Error(`Invalid params: ${validate.errors}`);

  return await cap.handler(params);
}
```

### External Registration (Alternative)

For systems where capabilities are declared in external config files rather than programmatically:

```yaml
# capabilities.yaml — declarative capability manifest
capabilities:
  - name: deploy
    tier: workflow
    description: Build and deploy the project
    schema:
      type: object
      properties:
        environment: { type: string, enum: [staging, production] }
      required: [environment]
    steps:
      - build: Run build and verify output
      - deploy: Push to target environment
```

The orchestrator discovers these at startup by scanning known directories or receiving registration calls from plugins.

## Implications

- JSON Schema declarations add upfront authoring cost but enable validation, documentation generation, and AI-driven tool selection
- Programmatic (internal) registration is simpler to debug — all capabilities are visible in one codebase
- External (file-based) registration decouples capability authoring from orchestrator code but introduces config parsing, schema drift, and discovery timing issues
- The tiered model helps the orchestrator reason about complexity — a "tool" call is cheap, a "workflow" may take hours
- Hot-reloading capabilities at runtime adds complexity (stale references, in-flight dispatches to removed capabilities)
- No schema validation on registration means malformed capability definitions fail at dispatch time, not load time

## Code Example

```javascript
// Full lifecycle: register, discover, dispatch
class CapabilityRegistry {
  constructor() {
    this.capabilities = new Map();
  }

  register(cap) {
    this.capabilities.set(cap.name, cap);
  }

  find(query) {
    // Simple keyword match — could be upgraded to semantic search
    return [...this.capabilities.values()].filter(cap =>
      cap.description.toLowerCase().includes(query.toLowerCase())
    );
  }

  async dispatch(name, params) {
    const cap = this.capabilities.get(name);
    if (!cap) throw new Error(`Unknown: ${name}`);
    return await cap.handler(params);
  }

  // Expose to AI model for tool-use decisions
  toToolDefinitions() {
    return [...this.capabilities.values()]
      .filter(c => c.tier === 'tool')
      .map(c => ({ name: c.name, description: c.description, input_schema: c.schema }));
  }
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
