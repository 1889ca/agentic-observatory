# Validation and Schema System

> Dual-layer validation using a custom params type system for tool definitions and Zod schemas for API route validation.

## Problem

Agent systems receive input from multiple sources -- LLM-generated tool calls, HTTP API requests, webhook payloads. Each source has different reliability characteristics. LLM output needs lightweight type coercion (models produce strings where numbers are expected), while API routes need strict schema validation with detailed error reporting. Without a clear separation, validation logic becomes tangled and inconsistent.

## Context

Riley has two distinct input boundaries: tools (called by Gemini, where parameters arrive as loosely-typed JSON) and API routes (called by clients, where request bodies need strict validation). The tool system uses a custom params format with a built-in type registry, while API routes use Zod schemas with Express middleware. These two systems are independent -- tools never use Zod, and API routes never use the params type system.

## Solution

### Tool Parameter Validation (Custom Params System)

Tools declare parameters using a custom `params` object where each key maps to a type definition with `type`, `required`, `default`, `enum`, `min`/`max`, and `description` fields. The type system lives in `lib/tools/factory/types.js` and provides built-in types with validation, transformation, and Gemini declaration mapping.

```js
// Tool definition uses custom params format (NOT Zod)
module.exports = defineTool({
  name: 'create_task',
  description: 'Create a new task',
  params: {
    title: { type: 'string', required: true, description: 'The task title' },
    priority: { type: 'number', default: 3, min: 1, max: 5 },
    status: { type: 'string', enum: ['pending', 'active', 'done'] },
    projectName: { type: 'project', description: 'Project to assign to' },
  },
  execute: async ({ title, priority, project }) => {
    // params are validated, coerced, and entities resolved
    return await createTask({ title, priority, project });
  },
});
```

The built-in type registry (`PARAM_TYPES`) handles:

- **Primitive types** -- `string`, `number`, `boolean` with automatic coercion (string `"42"` becomes number `42`, `"true"` becomes boolean `true`)
- **Format types** -- `date`, `email`, `url` with format-specific validation
- **Entity types** -- `project`, `client` that trigger automatic entity resolution (fuzzy-matching a name string to a database record)
- **Structural types** -- `object`, `array` for complex parameters

Each type defines a `geminiType` mapping (e.g., `string` maps to `'STRING'`), so `generateDeclaration()` can produce Gemini-compatible function declarations directly from the params definition.

### Validation Pipeline

Tool execution follows a three-step validation pipeline in `lib/tools/factory/validation.js`:

1. **`validateParams()`** -- checks required fields, applies defaults, runs type-specific `transform()` and `validate()`, enforces `enum`/`min`/`max` constraints
2. **`resolveEntities()`** -- for entity types (`project`, `client`), resolves name strings to database records via pluggable resolvers. Projects support `createIfMissing` for parallel tool execution
3. **Execute** -- only runs if both steps pass with zero errors

### API Route Validation (Zod)

API routes use a separate Zod-based validation layer in `lib/validation/`. Express middleware validates `req.body`, `req.query`, and `req.params` against Zod schemas, replacing raw values with parsed/transformed results.

```js
const { validate, schemas } = require('./lib/validation');

app.post('/api/tasks',
  validate({ body: schemas.task.create }),
  handler
);
```

The Zod layer provides pre-built schema modules for common domains (`common`, `entity`, `task`, `message`) plus middleware helpers (`validateBody`, `validateQuery`, `validatePartial`, `sanitizeBody`).

## Implications

- **Two systems, clear boundaries** -- tools use custom params (optimized for LLM output), API routes use Zod (optimized for HTTP clients). No overlap.
- **Declaration generation** -- the params format doubles as the source for Gemini function declarations, eliminating separate schema maintenance
- **Entity resolution is built-in** -- entity types automatically resolve fuzzy names to records, so tools never need manual lookup logic
- **Coercion trade-off** -- accepting `"42"` as `42` increases LLM resilience but could mask upstream model issues
- **Error messages for LLM feedback** -- validation errors are formatted so the model can understand what went wrong and self-correct on the next tool call

## Code Example

```js
// PARAM_TYPES entry (lib/tools/factory/types.js)
number: {
  geminiType: 'NUMBER',
  validate: (v) => typeof v === 'number' || v === undefined || v === null,
  transform: (v) => (typeof v === 'string' ? parseFloat(v) : v),
},

// Entity type with automatic resolution
project: {
  geminiType: 'STRING',
  validate: () => true,
  transform: (v) => v,
  resolve: true,
  resolveType: 'project',
  description: 'Project name',
},
```

## Related Patterns

- [Tools Factory and Declarative Tool Definition](./tools-factory-and-declarative-tool-definition.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
