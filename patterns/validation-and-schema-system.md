# Validation and Schema System

> Zod-based schema validation with type coercion, custom domain validators, and tool execution integration.

## Problem

Agent systems receive input from multiple sources -- user messages, LLM-generated tool calls, API requests, webhook payloads. Each source can produce malformed data. Without centralized validation, each handler writes ad-hoc checks that are inconsistent, incomplete, and hard to maintain.

## Context

Riley's tool system generates structured parameters from LLM output, which is inherently unreliable -- models may produce strings where numbers are expected, omit required fields, or invent parameters. The validation system sits between raw input and execution, ensuring type safety before any side effects occur.

## Solution

Zod schemas define the expected shape of every input boundary. The system provides three capabilities:

1. **Type coercion** -- automatically converts compatible types (string "42" to number 42, string "true" to boolean true) rather than rejecting valid-but-mistyped input
2. **Custom domain validators** -- reusable validators for domain concepts like entity IDs, date ranges, and slug formats
3. **Tool execution integration** -- tool definitions declare their parameter schema, and the tool executor validates input before calling the handler

```js
const taskSchema = z.object({
  title: z.string().min(1),
  priority: z.coerce.number().int().min(1).max(5).default(3),
  due: z.coerce.date().optional(),
  assignee: entityIdSchema.optional(),
});

// Tool definition with integrated validation
defineTool({
  name: 'create-task',
  parameters: taskSchema,
  handler: async (params) => {
    // params are already validated and coerced
    return await createTask(params);
  }
});
```

Key behaviors:

- **Fail before execution** -- invalid input never reaches the handler function
- **Coerce rather than reject** -- LLMs often produce correct values in wrong types; coercion accepts these gracefully
- **Reusable domain schemas** -- common shapes like entity references and date ranges are defined once and composed into larger schemas
- **Error messages for LLM feedback** -- validation errors are formatted so the LLM can understand what went wrong and self-correct

## Implications

- **Single validation boundary** -- all tool calls pass through the same validation layer regardless of which LLM generated them
- **Coercion trade-off** -- accepting "42" as 42 increases resilience but could mask upstream issues
- **Schema as documentation** -- Zod schemas serve as machine-readable parameter documentation for tool definitions
- **Composable** -- schemas compose naturally for nested and complex parameter structures

## Related Patterns

- [Tools Factory and Declarative Tool Definition](./tools-factory-and-declarative-tool-definition.md)
- [Tool Interceptor and Pre-Execution Correction](./tool-interceptor-and-pre-execution-correction.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
