# Pipeline Executor and Workflow Composition

> Composable data processing pipelines built from typed operations (map, filter, transform, parse, split) that can be stored by name, serialized, and reused across contexts.

## Problem

Data flowing through an AI orchestrator needs repeated transformation: parsing JSON from an API response, filtering irrelevant results, mapping fields to a different schema, splitting text for embedding. Writing these transformations inline produces scattered, untestable logic. When the same sequence of operations is needed in multiple places — a Slack message and a web request that both need the same enrichment pipeline — the logic gets duplicated or buried in shared utility functions with unclear contracts.

## Context

- Data arrives in varied formats: JSON, CSV, plain text, structured API responses
- The same transformation chain is needed across multiple entry points (channels, tools, scheduled jobs)
- Pipelines must be debuggable — when output is wrong, you need to trace which step produced the bad data
- Non-technical users (or the LLM itself) should be able to define and invoke pipelines without writing code
- Individual step failures should not necessarily kill the entire pipeline — some steps are optional or have fallbacks

## Solution

### Pipeline as Data

A pipeline is a plain object — an array of operation definitions with typed inputs and outputs. Because pipelines are data (not code), they can be serialized to JSON, stored in a database, and reconstructed at runtime:

```javascript
const enrichmentPipeline = {
  name: 'enrich-contact',
  steps: [
    { op: 'parse', format: 'json' },
    { op: 'map', fn: 'extractContactFields' },
    { op: 'filter', condition: { field: 'email', exists: true } },
    { op: 'transform', fn: 'normalizePhoneNumbers' },
    { op: 'deduplicate', key: 'email' },
  ],
};
```

### Operation Types

Each operation is a pure function with a single responsibility. The executor provides built-in operations and supports custom registered functions:

```javascript
const OPERATIONS = {
  map: (items, { fn }) => {
    const mapper = functionRegistry.get(fn);
    return items.map(mapper);
  },

  filter: (items, { condition }) => {
    return items.filter((item) => evaluateCondition(item, condition));
  },

  transform: (items, { fn }) => {
    const transformer = functionRegistry.get(fn);
    return transformer(items);
  },

  parse: (input, { format }) => {
    const parsers = {
      json: (data) => JSON.parse(typeof data === 'string' ? data : JSON.stringify(data)),
      csv: (data) => parseCSV(data),
      lines: (data) => String(data).split('\n').filter(Boolean),
      yaml: (data) => parseYAML(data),
    };
    const parser = parsers[format];
    if (!parser) throw new Error(`Unknown parse format: ${format}`);
    return parser(input);
  },

  split: (input, { separator, chunkSize }) => {
    if (chunkSize) {
      const text = String(input);
      const chunks = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
      }
      return chunks;
    }
    return String(input).split(separator || '\n');
  },

  merge: (inputs, { strategy }) => {
    if (strategy === 'concat') return inputs.flat();
    if (strategy === 'zip') return zip(...inputs);
    if (strategy === 'object') return Object.assign({}, ...inputs);
    return inputs.flat();
  },

  deduplicate: (items, { key }) => {
    const seen = new Set();
    return items.filter((item) => {
      const value = key ? item[key] : JSON.stringify(item);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  },
};
```

### Pipeline Executor

The executor runs steps sequentially, threading each step's output into the next step's input. Type coercion between steps handles common mismatches (single item vs. array, string vs. parsed object):

```javascript
async function executePipeline(pipeline, input) {
  let current = input;
  const trace = [];

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const operation = OPERATIONS[step.op];

    if (!operation) {
      throw new PipelineError(`Unknown operation: ${step.op}`, { step: i, pipeline: pipeline.name });
    }

    // Type coercion: ensure input matches expected shape
    current = coerceInput(current, step);

    try {
      const before = current;
      current = await operation(current, step);

      trace.push({
        step: i,
        op: step.op,
        inputSize: measureSize(before),
        outputSize: measureSize(current),
        status: 'ok',
      });
    } catch (err) {
      trace.push({ step: i, op: step.op, status: 'error', error: err.message });

      if (step.optional) {
        // Optional steps log the failure and pass input through unchanged
        continue;
      }

      if (step.fallback !== undefined) {
        current = step.fallback;
        continue;
      }

      // Non-optional step failure kills the pipeline
      throw new PipelineError(`Step ${i} (${step.op}) failed: ${err.message}`, {
        step: i,
        pipeline: pipeline.name,
        trace,
      });
    }
  }

  return { result: current, trace };
}
```

### Type Coercion Between Steps

Steps may produce output that doesn't exactly match the next step's expected input. The coercion layer handles predictable mismatches:

```javascript
function coerceInput(value, step) {
  // Array operations need arrays
  if (['map', 'filter', 'deduplicate'].includes(step.op)) {
    if (!Array.isArray(value)) {
      return [value];
    }
  }

  // Parse expects a string or buffer
  if (step.op === 'parse' && typeof value !== 'string' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }

  // Split expects a string
  if (step.op === 'split' && typeof value !== 'string') {
    return String(value);
  }

  return value;
}
```

### Named Pipeline Storage

Pipelines are stored by name in a registry. This allows the LLM (or scheduled jobs) to invoke a pipeline by reference rather than defining it inline every time:

```javascript
class PipelineRegistry {
  constructor() {
    this.pipelines = new Map();
  }

  register(pipeline) {
    if (!pipeline.name || !pipeline.steps?.length) {
      throw new Error('Pipeline must have a name and at least one step');
    }
    this.pipelines.set(pipeline.name, pipeline);
  }

  async run(name, input) {
    const pipeline = this.pipelines.get(name);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${name}. Available: ${this.listNames().join(', ')}`);
    }
    return executePipeline(pipeline, input);
  }

  listNames() {
    return Array.from(this.pipelines.keys());
  }

  serialize(name) {
    const pipeline = this.pipelines.get(name);
    return JSON.stringify(pipeline, null, 2);
  }

  load(json) {
    const pipeline = JSON.parse(json);
    this.register(pipeline);
    return pipeline.name;
  }
}
```

### Pipeline as a Tool

The pipeline system exposes itself as a tool declaration, so the LLM can create and run pipelines through the standard tool interface:

```javascript
const pipelineTool = {
  name: 'pipeline',
  description: 'Create, run, or list data processing pipelines',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'run', 'list', 'describe'] },
      name: { type: 'string', description: 'Pipeline name' },
      steps: { type: 'array', description: 'Pipeline steps (for create)' },
      input: { description: 'Input data (for run)' },
    },
    required: ['action'],
  },
  execute: async ({ action, name, steps, input }) => {
    switch (action) {
      case 'create':
        registry.register({ name, steps });
        return { created: name, stepCount: steps.length };
      case 'run':
        return registry.run(name, input);
      case 'list':
        return { pipelines: registry.listNames() };
      case 'describe':
        return registry.pipelines.get(name) || { error: `Not found: ${name}` };
    }
  },
};
```

## Implications

- Pipelines as data means they can be created, modified, and shared without code deployments — the LLM can define a pipeline in one conversation and a scheduled job can invoke it later
- Sequential step execution is simpler to debug than parallel processing, but limits throughput for independent operations. A future optimization could detect independent steps and parallelize them
- The trace array provides full observability: every step's input size, output size, and status. This makes debugging straightforward — you can see exactly where a pipeline diverged from expectations
- Type coercion between steps introduces implicit behavior. A `map` step silently wrapping a single object in an array is convenient but can mask bugs where the previous step should have returned an array
- Optional steps and fallbacks add resilience but can hide persistent failures. A step that silently falls back on every invocation indicates a misconfigured pipeline, not graceful degradation
- Pure function operations make pipelines testable in isolation — each operation can be unit tested with known inputs and expected outputs, independent of the executor
- The function registry (`fn: 'extractContactFields'`) creates an indirection layer. The pipeline definition references functions by name, so the registry must contain all referenced functions at execution time. Missing functions fail at runtime, not at definition time

## Code Example

```javascript
// Define, register, and execute a pipeline
const registry = new PipelineRegistry();

// Register a reusable pipeline
registry.register({
  name: 'process-api-response',
  steps: [
    { op: 'parse', format: 'json' },
    { op: 'map', fn: 'extractRecords' },
    { op: 'filter', condition: { field: 'status', equals: 'active' } },
    { op: 'deduplicate', key: 'id' },
    { op: 'transform', fn: 'enrichWithMetadata' },
  ],
});

// Execute the pipeline
const apiResponse = await fetch('https://api.example.com/data');
const rawText = await apiResponse.text();

const { result, trace } = await registry.run('process-api-response', rawText);

// Trace shows step-by-step execution
// [
//   { step: 0, op: 'parse', inputSize: 4096, outputSize: 3200, status: 'ok' },
//   { step: 1, op: 'map', inputSize: 50, outputSize: 50, status: 'ok' },
//   { step: 2, op: 'filter', inputSize: 50, outputSize: 32, status: 'ok' },
//   { step: 3, op: 'deduplicate', inputSize: 32, outputSize: 28, status: 'ok' },
//   { step: 4, op: 'transform', inputSize: 28, outputSize: 28, status: 'ok' },
// ]
```

## Related Patterns

- [Message Processing Pipeline](./message-processing-pipeline.md)
- [Tool Interceptor and Pre-execution Correction](./tool-interceptor-and-pre-execution-correction.md)
