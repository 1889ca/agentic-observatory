# Tools Factory and Declarative Tool Definition

> Declarative tool definitions with parameter schemas, automatic validation, error handling, and tool categorization for agent-available tools.

## Problem

An AI agent needs access to dozens of tools. Each tool needs parameter validation, error handling, categorization for the system prompt, and consistent invocation. Building each tool as a standalone function leads to inconsistent interfaces, missing validation, and no central registry for the agent to discover what's available. Every tool author reimplements the same boilerplate: parse parameters, check required fields, catch errors, format responses. Bugs hide in the inconsistencies.

## Context

Any AI agent system where tools are the primary mechanism for the agent to take action. Tools vary widely (database queries, API calls, file operations, memory search) but share common infrastructure needs: parameter validation, entity resolution (turning human-readable names into database IDs), error wrapping, cache invalidation, and undo tracking. The agent's system prompt is generated from tool declarations, so tools must self-describe.

## Solution

A factory function accepts a declarative tool definition and returns a fully wired tool with validation, entity resolution, error handling, and a Gemini-compatible function declaration. Tool authors write only the definition object and the core logic; the factory handles everything else.

### Tool Definition Shape

Each tool is defined with:
- `name`: unique identifier (snake_case)
- `description`: agent-readable description (used verbatim in the system prompt)
- `category`: grouping for UI display (e.g., `'memory'`, `'focus'`, `'communication'`)
- `params`: parameter definitions with types, descriptions, required flags, enums, and defaults
- `execute`: the core implementation function, receives validated and resolved parameters
- `message`: success message template (string or function of result)
- `errorPrefix`: human-readable prefix for error messages

### Parameter Type System

Parameters are declared with a type that maps to a built-in type definition. Each type provides:
- A **Gemini-compatible type** (STRING, NUMBER, BOOLEAN, OBJECT, ARRAY) for function declaration generation
- A **validate** function to check values after transformation
- A **transform** function to coerce input (e.g., `"true"` to `true`, `"42"` to `42`)

Special types like `project` and `client` trigger **entity resolution** -- the factory automatically resolves a human-readable name (e.g., `"website redesign"`) to a database entity before the handler runs.

```javascript
const PARAM_TYPES = {
  string: {
    geminiType: 'STRING',
    validate: (v) => typeof v === 'string',
    transform: (v) => (v === '' ? undefined : v),
  },
  number: {
    geminiType: 'NUMBER',
    validate: (v) => typeof v === 'number',
    transform: (v) => (typeof v === 'string' ? parseFloat(v) : v),
  },
  boolean: {
    geminiType: 'BOOLEAN',
    validate: (v) => typeof v === 'boolean',
    transform: (v) => {
      if (v === 'true') return true
      if (v === 'false') return false
      return v
    },
  },
  // Special types that trigger entity resolution
  project: {
    geminiType: 'STRING',
    validate: () => true,
    transform: (v) => v,
    resolve: true,
    resolveType: 'project',
  },
}
```

### Automatic Validation Pipeline

When a tool is invoked, the factory execute wrapper runs a multi-phase pipeline before the handler:

1. **Validate parameters** -- check required fields, types, enum constraints, min/max bounds
2. **Resolve entities** -- for `project`/`client` type params, look up the entity by name and replace with the full database record
3. **Execute core logic** -- call the tool author's function with clean, validated, resolved parameters
4. **Wrap response** -- format success as `{ success: true, message, ...data }` or error as `{ error: message }`

Validation errors short-circuit immediately -- the handler never runs with bad input.

```javascript
function validateParams(args, paramDefs) {
  const values = {}
  const errors = []

  for (const [name, def] of Object.entries(paramDefs)) {
    const typeDef = PARAM_TYPES[def.type]
    let value = args[name] === undefined ? def.default : args[name]

    // Transform (e.g., string "42" -> number 42)
    if (value !== undefined && value !== null) {
      value = typeDef.transform(value)
    }

    // Check required
    if (def.required && (value === undefined || value === null || value === '')) {
      errors.push(`${name} is required`)
      continue
    }

    // Validate type
    if (value !== undefined && value !== null && !typeDef.validate(value)) {
      errors.push(`${name} must be a valid ${def.type}`)
      continue
    }

    // Validate enum
    if (def.enum && value !== undefined) {
      if (!def.enum.includes(value)) {
        errors.push(`${name} must be one of: ${def.enum.join(', ')}`)
        continue
      }
    }

    values[name] = value
  }

  return { values, errors }
}
```

### Error Wrapping

All handler errors are caught and wrapped in a consistent format. The agent never sees raw stack traces -- it gets a structured error message it can reason about and report to the user:

```javascript
async function execute(args = {}) {
  try {
    const { values, errors } = validateParams(args, params)
    if (errors.length > 0) return error(errors[0])

    const { resolved, errors: resolutionErrors } = await resolveEntities(values, params)
    if (resolutionErrors.length > 0) return error(resolutionErrors[0])

    const result = await executeCore(resolved)
    if (result?.error) return result

    return success(formatMessage(result), result)
  } catch (err) {
    return error(`${errorPrefix}: ${err.message}`)
  }
}
```

### Declaration Generation

The factory auto-generates Gemini function declarations from the parameter definitions. Enum values are appended to descriptions. Required fields are collected into a `required` array. The agent sees these declarations in its system prompt and knows exactly what parameters each tool accepts:

```javascript
function generateDeclaration(toolDef) {
  const properties = {}
  const required = []

  for (const [name, def] of Object.entries(toolDef.params)) {
    properties[name] = {
      type: PARAM_TYPES[def.type].geminiType,
      description: def.description,
    }
    if (def.enum) {
      properties[name].description += ` (${def.enum.join('|')})`
    }
    if (def.required) required.push(name)
  }

  return {
    name: toolDef.name,
    description: toolDef.description,
    parameters: { type: 'OBJECT', properties, ...(required.length > 0 ? { required } : {}) },
  }
}
```

### Specialized Factory Variants

Two higher-level factories compose on top of `defineTool`:

- **`defineListTool`** -- for query/list operations. Automatically adds a `limit` parameter, wraps the query result with count, and generates appropriate "Found N items" messages.
- **`defineActionTool`** -- for create/update/delete operations. Infers success messages and error prefixes from the action type and entity name.

### Tool Categorization

Tools declare a `category` that maps to a UI category registry. The registry provides icon, color, and grouping for the chat interface. A reverse lookup index enables O(1) category resolution. With 28+ tools, categories help both the UI and the LLM reason about tool groupings:

```javascript
const TOOL_CATEGORIES = {
  entity:       { tools: ['entity', 'navigate', 'focus'], icon: 'layers', color: '#4A90A4' },
  knowledge:    { tools: ['remember', 'search'], icon: 'brain', color: '#9370DB' },
  communication:{ tools: ['inbox', 'message'], icon: 'mail', color: '#5BA4CF' },
  deliberation: { tools: ['deliberate', 'research'], icon: 'users', color: '#E67E22' },
  media:        { tools: ['generate-image', 'generate-video'], icon: 'image', color: '#E74C3C' },
  integrations: { tools: ['github', 'finances', 'hue-control'], icon: 'plug', color: '#2ECC71' },
  ui:           { tools: ['widget'], icon: 'layout', color: '#9B59B6' },
  utility:      { tools: [], icon: 'gear', color: '#888888' }, // Catch-all
}

function getToolCategory(toolName) {
  return toolToCategory[toolName] || 'utility'
}
```

## Implications

- Declarative definitions make tools self-documenting -- the parameter schema IS the documentation, and it generates both the system prompt declaration and the validation logic
- Tool authors write ~30 lines of definition instead of ~100 lines of boilerplate, which means fewer bugs and faster iteration
- Central validation prevents the agent from calling tools with bad parameters -- errors are caught before any side effects
- Error wrapping means tool failures are always recoverable: the agent gets a structured message, not a crash
- Entity resolution (project/client name to database record) happens transparently, so tool handlers never deal with lookups
- The type system's transform layer handles LLM quirks (numbers as strings, booleans as `"true"`) without tool authors needing to know about them
- Categories enable the UI to visually group tool results without the tool author specifying display logic
- The factory returns both a `declaration` (for the system prompt) and an `execute` (for runtime), keeping the two concerns in sync -- renaming a parameter updates both the schema and the validation

## Code Example

```javascript
// A complete tool definition using the factory
const { defineTool } = require('../lib/tools/factory')

module.exports = defineTool({
  name: 'remember',
  description: 'Save important information to long-term memory.',
  category: 'memory',
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
      type: 'string',
      description: 'ISO date if time-bound',
    },
  },

  async execute({ fact, category, expiresAt }) {
    // Parameters are already validated, transformed, and resolved
    const factId = await facts.save({
      content: fact,
      category,
      confidence: 1.0,
      expiresAt: expiresAt || null,
    })
    return { factId }
  },

  message: () => "Got it, I'll remember that.",
  errorPrefix: 'Failed to remember',
})

// A list tool using the specialized factory
const { defineListTool } = require('../lib/tools/factory')

module.exports = defineListTool({
  name: 'list_todos',
  description: 'List todos with optional filters.',
  itemName: 'todo',
  params: {
    status: {
      type: 'string',
      enum: ['active', 'completed', 'all'],
      default: 'active',
      description: 'Filter by status',
    },
    projectName: {
      type: 'project', // Triggers automatic entity resolution
      description: 'Filter by project name',
    },
  },
  query: async ({ status, project }) => {
    // 'project' is the resolved entity (not the string name)
    return await db.todos.find({ status, projectId: project?.id })
  },
})
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Declarative Capability System](./declarative-capability-system.md)
