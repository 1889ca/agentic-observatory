# Tools Factory and Declarative Tool Definition

> Modular factory system split across 8+ files with declarative tool definitions using a custom `PARAM_TYPES` format (not Zod), automatic Gemini declaration generation, entity resolution, and three factory variants for different tool shapes.

## Problem

An AI agent needs access to dozens of tools. Each tool needs parameter validation, error handling, categorization for the system prompt, and consistent invocation. Building each tool as a standalone function leads to inconsistent interfaces, missing validation, and no central registry. Every tool author reimplements the same boilerplate: parse parameters, check required fields, catch errors, format responses. Bugs hide in the inconsistencies.

## Context

Any AI agent system where tools are the primary mechanism for the agent to take action. Tools vary widely (database queries, API calls, memory search) but share common infrastructure needs: parameter validation, entity resolution (turning human-readable names into database IDs), error wrapping, cache invalidation, and undo tracking. The agent's system prompt is generated from tool declarations, so tools must self-describe.

## Solution

### Modular Factory Architecture

The factory has been refactored from a single file into a directory (`lib/tools/factory/`) with 8+ files:

```
lib/tools/factory/
  index.js          — re-exports all factory functions
  define-tool.js    — core defineTool() factory
  define-list-tool.js — specialized factory for query/list operations
  define-action-tool.js — specialized factory for create/update/delete operations
  types.js          — PARAM_TYPES type system
  validation.js     — parameter validation and entity resolution
  declaration.js    — Gemini function declaration generation
  resolvers.js      — project/client entity resolvers
  responses.js      — standardized success/error response helpers
```

The shim at `lib/tools/factory.js` re-exports the directory for backward compatibility:

```javascript
// lib/tools/factory.js
module.exports = require('./factory/index');
```

### Custom Parameter Type System (Not Zod)

Parameters use a custom `PARAM_TYPES` object where each type provides a Gemini-compatible type string, a validation function, and a transform function. This is not Zod — it's a purpose-built system for Gemini function declarations:

```javascript
// lib/tools/factory/types.js
const PARAM_TYPES = {
  string: {
    geminiType: 'STRING',
    validate: (v) => typeof v === 'string' || v === undefined || v === null,
    transform: (v) => (v === '' ? undefined : v),
  },
  number: {
    geminiType: 'NUMBER',
    validate: (v) => typeof v === 'number' || v === undefined || v === null,
    transform: (v) => (typeof v === 'string' ? parseFloat(v) : v),
  },
  boolean: {
    geminiType: 'BOOLEAN',
    validate: (v) => typeof v === 'boolean' || v === undefined || v === null,
    transform: (v) => { if (v === 'true') return true; if (v === 'false') return false; return v; },
  },
  date: {
    geminiType: 'STRING',
    validate: (v) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v) || !isNaN(Date.parse(v)),
    transform: (v) => v,
    description: 'Date in YYYY-MM-DD format',
  },
  email: {
    geminiType: 'STRING',
    validate: (v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    transform: (v) => v?.toLowerCase()?.trim(),
  },
  url: {
    geminiType: 'STRING',
    validate: (v) => { try { new URL(v); return true; } catch { return false; } },
    transform: (v) => v,
  },
  // Special types that trigger entity resolution
  project: {
    geminiType: 'STRING',
    resolve: true,
    resolveType: 'project',
    description: 'Project name',
  },
  client: {
    geminiType: 'STRING',
    resolve: true,
    resolveType: 'client',
    description: 'Client name',
  },
};
```

### Automatic Validation Pipeline

When a tool is invoked, the factory wrapper runs a multi-phase pipeline:

1. **Validate parameters** — check required fields, types, enum constraints, min/max bounds
2. **Resolve entities** — for `project`/`client` type params, look up by name and replace with the full database record
3. **Get before state** — if undoable, capture state for undo tracking
4. **Execute core logic** — call the tool author's function with validated, resolved parameters
5. **Track undo** — record the action for potential reversal
6. **Invalidate caches** — clear any specified UI cache keys
7. **Format response** — wrap in standardized success/error format

```javascript
// lib/tools/factory/define-tool.js
function defineTool(toolDef) {
  const { name, params = {}, execute: executeCore, message, errorPrefix, undoable, aliases = [] } = toolDef;
  const declaration = generateDeclaration(toolDef);

  async function execute(args = {}) {
    try {
      const { values, errors } = validateParams(args, params);
      if (errors.length > 0) return error(errors[0]);

      const { resolved, errors: resolutionErrors } = await resolveEntities(values, params);
      if (resolutionErrors.length > 0) return error(resolutionErrors[0]);

      const result = await executeCore(resolved);
      if (result?.error) return result;

      // Undo tracking, cache invalidation, response formatting...
      return success(formatMessage(result), result);
    } catch (err) {
      return error(`${errorPrefix || `Error in ${name}`}: ${err.message}`);
    }
  }

  return { declaration, execute, aliases };
}
```

### Declaration Generation

The factory auto-generates Gemini function declarations from parameter definitions. Enum values are appended to descriptions. Array types include item type specifications:

```javascript
// lib/tools/factory/declaration.js
function generateDeclaration(toolDef) {
  const properties = {};
  const required = [];

  for (const [name, def] of Object.entries(toolDef.params || {})) {
    const typeDef = PARAM_TYPES[def.type] || PARAM_TYPES.string;
    properties[name] = {
      type: typeDef.geminiType,
      description: def.description || typeDef.description || `Parameter: ${name}`,
    };

    if (def.type === 'array') {
      properties[name].items = { type: def.items?.type?.toUpperCase() || 'STRING' };
    }
    if (def.enum) {
      properties[name].description += ` (${def.enum.join('|')})`;
    }
    if (def.required) required.push(name);
  }

  return {
    name: toolDef.name,
    description: toolDef.description,
    parameters: { type: 'OBJECT', properties, ...(required.length > 0 ? { required } : {}) },
  };
}
```

### Entity Resolution

The `project` and `client` param types trigger automatic entity resolution. The resolver looks up entities by name and replaces the string value with the database record:

```javascript
// lib/tools/factory/validation.js
async function resolveEntities(values, paramDefs) {
  const resolved = { ...values };
  for (const [name, def] of Object.entries(paramDefs)) {
    const typeDef = PARAM_TYPES[def.type];
    if (typeDef?.resolve && values[name]) {
      const resolver = RESOLVERS[typeDef.resolveType];
      const resolverOptions = typeDef.resolveType === 'project' ? { createIfMissing: true } : {};
      const { entity, error } = await resolver(values[name], resolverOptions);
      if (error) { errors.push(error); }
      else { resolved[name.replace(/Name$/, '')] = entity; }
    }
  }
  return { resolved, errors };
}
```

Project resolution includes `createIfMissing: true`, enabling parallel tool execution where a project and its tasks are created simultaneously.

### Specialized Factory Variants

Two higher-level factories compose on top of `defineTool`:

- **`defineListTool`** — for query/list operations. Automatically adds a `limit` parameter, wraps the query result with count, and generates "Found N items" messages
- **`defineActionTool`** — for create/update/delete operations. Infers success messages and error prefixes from the action type and entity name

### Tool Categorization

Tools are mapped to visual categories for the chat UI. Categories have been renamed from domain-specific names to broader groupings:

```javascript
// lib/tools/categories.js
const TOOL_CATEGORIES = {
  messaging:   { tools: ['message', 'inbox'], icon: '✉', color: '#4A90A4' },
  calendar:    { tools: ['calendar_ops'], icon: '📅', color: '#7B68EE' },
  entities:    { tools: ['entity'], icon: '☑', color: '#50C878' },
  github:      { tools: ['github_ops'], icon: '⎇', color: '#6e5494' },
  files:       { tools: ['files'], icon: '📁', color: '#FF8C00' },
  automation:  { tools: ['skill', 'workflow', 'trigger'], icon: '⚡', color: '#FFD700' },
  agent:       { tools: ['agent'], icon: '🤖', color: '#DB7093' },
  workspace:   { tools: ['widget'], icon: '🖥', color: '#20B2AA' },
  knowledge:   { tools: ['remember', 'recall', 'search_memory'], icon: '🧠', color: '#9370DB' },
  utility:     { tools: [], icon: '⚙', color: '#888888' },  // Catch-all
};
```

### Standardized Response Helpers

Both the factory and individual tools use shared response helpers:

```javascript
// lib/tools/factory/responses.js
function success(message, data = {}) {
  return { success: true, message, ...data };
}

function error(message, hint = null) {
  const response = { error: message };
  if (hint) response.hint = hint;
  return response;
}
```

## Implications

- The modular factory directory (8+ files) separates concerns cleanly — types, validation, declaration generation, and response formatting are independently maintainable
- Custom `PARAM_TYPES` (not Zod) provides Gemini-specific type mapping with transforms that handle LLM quirks (numbers as strings, booleans as `"true"`)
- Entity resolution with `createIfMissing: true` for projects enables a natural pattern where the LLM creates a project and its tasks in parallel tool calls
- The `aliases` field allows a single tool implementation to be invoked under multiple names (e.g., `add_widget` routing to `widget` with `{ action: 'add' }`)
- Undo tracking is built into the factory pipeline — tool authors opt in with an `undoable` config object, and the factory handles state capture and undo stack management
- Category names are UI-oriented (messaging, entities, workspace) rather than domain-oriented — the catch-all `utility` category absorbs unlisted tools
- The declaration generation guarantees the system prompt and validation logic stay in sync — changing a parameter definition updates both

## Code Example

```javascript
// A complete tool definition using the factory
const { defineTool } = require('../lib/tools/factory');

module.exports = defineTool({
  name: 'remember',
  description: 'Save important information to long-term memory.',
  category: 'knowledge',
  params: {
    fact: {
      type: 'string',
      required: true,
      description: 'The information to remember',
    },
    category: {
      type: 'string',
      default: 'fact',
      enum: ['preference', 'fact', 'decision', 'context', 'deadline'],
      description: 'Category of information',
    },
    expiresAt: {
      type: 'date',
      description: 'Expiration date if time-bound',
    },
  },

  async execute({ fact, category, expiresAt }) {
    const factId = await facts.save({ content: fact, category, confidence: 1.0, expiresAt });
    return { factId };
  },

  message: () => "Got it, I'll remember that.",
  errorPrefix: 'Failed to remember',
});

// A list tool using the specialized factory
const { defineListTool } = require('../lib/tools/factory');

module.exports = defineListTool({
  name: 'list_todos',
  description: 'List todos with optional filters.',
  itemName: 'todo',
  params: {
    status: {
      type: 'string',
      enum: ['active', 'completed', 'all'],
      default: 'active',
    },
    projectName: {
      type: 'project',  // Triggers entity resolution + createIfMissing
      description: 'Filter by project name',
    },
  },
  query: async ({ status, project }) => {
    return await db.todos.find({ status, projectId: project?.id });
  },
});
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Declarative Capability System](./declarative-capability-system.md)
