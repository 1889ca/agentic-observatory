# Tool Interceptor and Pre-execution Correction

> Proactive validation layer that catches and corrects malformed tool call parameters before execution, using schema-based type inference, entity normalization, and structured correction feedback.

## Problem

LLMs frequently make tool calls with subtly wrong parameters: passing a JSON string where an object is expected, using a human-readable name instead of an ID, formatting dates inconsistently, or omitting required fields. Catching these errors after execution wastes a full round-trip — the tool fails, the error propagates back, the LLM retries. Worse, some tools have side effects, so executing with bad parameters isn't just wasteful — it's dangerous.

## Context

- An orchestrator dispatching LLM-generated tool calls in parallel batches
- Tools declared with JSON Schema definitions (types, required fields, enums)
- The LLM references entities by natural language names ("the billing project") rather than internal IDs
- Date formats, aliases, and shorthand vary across LLM outputs
- Some corrections are unambiguous (type coercion), while others require entity resolution against a known registry
- The tool loop already handles post-execution error recovery — this layer prevents errors that never need to happen

## Solution

### Interceptor Position in the Tool Loop

The interceptor runs synchronously between deduplication and parallel execution. Every tool call passes through it before any side effects occur:

```javascript
// tool-loop-orchestrator.js
while (response.functionCalls?.length > 0) {
  const uniqueCalls = deduplicateCalls(response.functionCalls);

  // Intercept BEFORE execution — proactive, not reactive
  const { accepted, corrections } = interceptToolCalls(uniqueCalls);

  // Execute only validated calls
  const results = await Promise.all(
    accepted.map((call) => executeSingleTool(call, userId, correlationId))
  );

  // Feed corrections back as tool responses so the LLM learns
  const allResponses = [
    ...results.map((r) => r.response),
    ...corrections.map((c) => ({
      functionResponse: { name: c.call.name, response: c.correction },
    })),
  ];

  response = await chat.sendMessage(allResponses);
}
```

### Shape-Based Type Inference

The interceptor detects type mismatches by comparing the actual parameter shape against the tool's declared schema. When the fix is unambiguous, it corrects silently:

```javascript
function inferAndCoerceTypes(args, schema) {
  const corrected = { ...args };
  const fixes = [];

  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties?.[key];
    if (!expected) continue;

    // String containing JSON where an object is expected
    if (expected.type === 'object' && typeof value === 'string') {
      try {
        corrected[key] = JSON.parse(value);
        fixes.push({ field: key, from: 'string', to: 'object', action: 'parsed' });
      } catch {
        fixes.push({ field: key, error: 'String is not valid JSON' });
      }
    }

    // Object where a string is expected (e.g., passing { id: "abc" } instead of "abc")
    if (expected.type === 'string' && typeof value === 'object' && value !== null) {
      const candidate = value.id || value.name || value.value;
      if (candidate) {
        corrected[key] = String(candidate);
        fixes.push({ field: key, from: 'object', to: 'string', action: 'extracted' });
      }
    }

    // Number passed as string
    if (expected.type === 'number' && typeof value === 'string') {
      const parsed = Number(value);
      if (!isNaN(parsed)) {
        corrected[key] = parsed;
        fixes.push({ field: key, from: 'string', to: 'number', action: 'coerced' });
      }
    }
  }

  return { corrected, fixes };
}
```

### Parameter Validation

Required fields, enum values, and type constraints are checked against the tool's schema. Validation failures produce structured rejection messages:

```javascript
function validateParams(args, schema) {
  const errors = [];

  // Required field check
  for (const field of schema.required || []) {
    if (args[field] === undefined || args[field] === null) {
      errors.push({ field, error: 'required', message: `Missing required field: ${field}` });
    }
  }

  // Enum constraint check
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (prop?.enum && !prop.enum.includes(value)) {
      errors.push({
        field: key,
        error: 'enum',
        message: `Invalid value "${value}" for ${key}. Must be one of: ${prop.enum.join(', ')}`,
      });
    }
  }

  return errors;
}
```

### Entity Normalization

When the LLM references entities by display name, alias, or partial match, the interceptor resolves them to canonical identifiers:

```javascript
function normalizeEntities(args, schema, registry) {
  const normalized = { ...args };
  const resolutions = [];

  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop?.entityType) continue;

    // Value is already a valid ID
    if (registry.hasId(prop.entityType, value)) continue;

    // Try to resolve by name, alias, or partial match
    const resolved = registry.resolveByName(prop.entityType, value);
    if (resolved) {
      normalized[key] = resolved.id;
      resolutions.push({
        field: key,
        from: value,
        to: resolved.id,
        resolvedAs: resolved.name,
      });
    }
  }

  // Normalize date formats to ISO 8601
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && isDateField(key, schema)) {
      const parsed = parseFlexibleDate(value);
      if (parsed) {
        normalized[key] = parsed.toISOString();
        resolutions.push({ field: key, from: value, to: normalized[key], action: 'date_normalized' });
      }
    }
  }

  return { normalized, resolutions };
}
```

### Interceptor Orchestration

The main interceptor function composes validation, type coercion, and entity normalization into a single pass per call:

```javascript
function interceptToolCalls(calls) {
  const accepted = [];
  const corrections = [];

  for (const call of calls) {
    const schema = registry.getSchema(call.name);
    if (!schema) {
      // Unknown tool — reject with hint
      corrections.push({
        call,
        correction: {
          error: `Unknown tool "${call.name}". Available tools: ${registry.listNames().join(', ')}`,
        },
      });
      continue;
    }

    // Phase 1: Type coercion (silent fixes)
    const { corrected, fixes } = inferAndCoerceTypes(call.args, schema);

    // Phase 2: Entity normalization
    const { normalized, resolutions } = normalizeEntities(corrected, schema, entityRegistry);

    // Phase 3: Validation (after coercion, so corrected values are checked)
    const errors = validateParams(normalized, schema);

    if (errors.length > 0) {
      corrections.push({
        call,
        correction: {
          error: 'Parameter validation failed',
          errors,
          fixes,
          resolutions,
        },
      });
    } else {
      accepted.push({ ...call, args: normalized });
    }
  }

  return { accepted, corrections };
}
```

## Implications

- Pre-execution correction eliminates an entire class of retry loops — type mismatches and missing fields never reach the tool
- The interceptor is stateless by design: it validates the current call in isolation, with no memory of previous corrections. This keeps it fast and predictable, but means the LLM may repeat the same mistake across turns
- Corrections returned as tool responses teach the LLM within the conversation context — the model sees exactly what was wrong and can adjust subsequent calls
- Entity normalization creates a dependency on the entity registry being current. Stale registries cause false rejections
- Silent type coercion (string-to-object parsing) trades explicitness for throughput. The LLM never knows it made a mistake, which means it won't learn to avoid it — but the user gets a faster response
- Running synchronously in the tool loop adds latency proportional to the number of calls per batch. For most batches (1-5 calls), this is negligible
- The interceptor cannot catch semantic errors (calling the right tool with valid parameters but wrong intent). That remains the domain of post-execution verification

## Code Example

```javascript
// Complete interceptor integration with the tool loop
async function runToolLoopWithInterception(chat, initialResponse, userId) {
  let response = initialResponse;
  let iterations = 0;

  while (response.functionCalls?.length > 0 && iterations < MAX_ITERATIONS) {
    const uniqueCalls = deduplicateCalls(response.functionCalls);

    // Intercept: validate, coerce, normalize
    const { accepted, corrections } = interceptToolCalls(uniqueCalls);

    // Log corrections for observability (non-blocking)
    if (corrections.length > 0) {
      logCorrections(corrections).catch(() => {});
    }

    // Execute validated calls in parallel
    const results = await Promise.all(
      accepted.map((call) => executeSingleTool(call, userId))
    );

    // Merge execution results with correction feedback
    const feedback = [
      ...results.map((r) => r.response),
      ...corrections.map((c) => ({
        functionResponse: {
          name: c.call.name,
          response: c.correction,
        },
      })),
    ];

    response = await chat.sendMessage(feedback);
    iterations++;
  }

  return response;
}
```

## Related Patterns

- [Message Processing Pipeline](./message-processing-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
