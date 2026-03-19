# Capability Manifest Registration

> Dual registration system combining a generic Map-based tool registry with entity/widget type resolution using canonical names, aliases, and type-specific metadata.

## Problem

An orchestrator managing multiple tools, entity types, and widgets needs to know what's available — which actions it can take, what entity types exist, and how to resolve user references to canonical names. A single flat registry doesn't capture the semantic differences between tools (stateless operations), entity types (data models with CRUD), and widgets (UI components). But maintaining entirely separate systems creates fragmentation.

## Context

- An orchestrator with both programmatic tools and data-model-aware entity operations
- Entity types have aliases (user says "todo", system calls it "task")
- Widgets render entity-specific UI components
- Need for both generic capability lookup and type-aware resolution
- Implementation uses internal registration at startup, not external config files

## Solution

### Generic Tool Registry

Tools are registered in a simple `Map` with name-based lookup:

```javascript
// capabilities/registry/queries.js
const capabilities = new Map();

function register(name, capability) {
  capabilities.set(name, capability);
}

function get(name) {
  return capabilities.get(name) || null;
}

function getAll() {
  return [...capabilities.values()];
}

// AI model can reason about available tools
function getDeclarations() {
  return getAll().map(cap => ({
    name: cap.name,
    description: cap.description,
    parameters: cap.schema,
  }));
}
```

### Entity Type Resolution

Entity types use a separate system with canonical names, aliases, and type-specific metadata. The `resolveEntityType()` function handles user-facing name variations:

```javascript
// capability-manifest.js
const ENTITY_TYPES = {
  task: {
    aliases: ['todo', 'item', 'ticket'],
    fields: ['title', 'status', 'priority', 'assignee'],
    defaultSort: 'priority',
  },
  note: {
    aliases: ['memo', 'doc', 'document'],
    fields: ['title', 'content', 'tags'],
    defaultSort: 'updated_at',
  },
  event: {
    aliases: ['meeting', 'appointment', 'calendar_event'],
    fields: ['title', 'start', 'end', 'attendees'],
    defaultSort: 'start',
  },
};

function getEntityType(type) {
  return ENTITY_TYPES[type] || null;
}

function resolveEntityType(type) {
  // Direct match
  if (ENTITY_TYPES[type]) return type;

  // Alias resolution
  for (const [canonical, meta] of Object.entries(ENTITY_TYPES)) {
    if (meta.aliases.includes(type)) return canonical;
  }

  // Unknown type — return as-is for dynamic entity support
  return type;
}
```

### Widget Type Maps

Widgets map entity types to UI components. This allows the system to render entity-specific cards, forms, and views:

```javascript
const WIDGET_TYPES = {
  task: {
    card: 'TaskCard',
    form: 'TaskForm',
    list: 'TaskList',
    inline: true,  // Can render inline in chat
  },
  note: {
    card: 'NoteCard',
    form: 'NoteEditor',
    list: 'NoteList',
    inline: true,
  },
};

function getWidgetForEntity(entityType) {
  const resolved = resolveEntityType(entityType);
  return WIDGET_TYPES[resolved] || null;
}
```

### Combined Resolution Flow

When the LLM invokes an entity operation, the system resolves through both registries:

```javascript
async function handleEntityOperation(action, typeName, data) {
  // 1. Resolve the entity type (handles aliases)
  const resolvedType = resolveEntityType(typeName);
  const typeMeta = getEntityType(resolvedType);

  // 2. Get the generic 'entity' tool from the registry
  const entityTool = get('entity');

  // 3. Execute with resolved type
  const result = await entityTool.execute({
    action,
    entityType: resolvedType,
    data,
  });

  // 4. Determine widget for response rendering
  const widget = getWidgetForEntity(resolvedType);
  if (widget?.inline) {
    return { result, render: widget.card };
  }

  return { result };
}
```

## Implications

- The dual system (Map registry + entity type maps) means two places to look when debugging capability issues
- Alias resolution is linear scan — fine for dozens of entity types, would need indexing for hundreds
- Unknown entity types pass through (`return type`) rather than throwing, enabling dynamic entity support without pre-registration
- Widget maps create coupling between entity types and UI components — adding an entity type requires a corresponding widget entry for full functionality
- No schema validation on registration — malformed definitions fail at execution time, not load time
- Entity type metadata (fields, defaultSort) enables the LLM to make informed decisions about queries without additional tool calls

## Code Example

```javascript
// Registration at startup
register('entity', {
  name: 'entity',
  description: 'Create, read, update, or delete entities',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'read', 'update', 'delete', 'list'] },
      entityType: { type: 'string' },
      data: { type: 'object' },
    },
    required: ['action', 'entityType'],
  },
  handler: handleEntityOperation,
});

// LLM calls: entity({ action: 'create', entityType: 'todo', data: { title: 'Fix bug' } })
// → resolveEntityType('todo') → 'task'
// → handleEntityOperation('create', 'task', { title: 'Fix bug' })
// → returns { result: { id: '...', type: 'task' }, render: 'TaskCard' }
```

## Relationship to Declarative Capability System

This pattern and [Declarative Capability System](./declarative-capability-system.md) document different aspects of Riley's unified `lib/capabilities/` system:

- **Capability Manifest Registration (this pattern)** — Describes the runtime registry: Map-based tool lookup, entity type resolution with aliases, and widget type mapping.
- **Declarative Capability System** — Describes the four-tier capability model (tools, skills, reflexes, workflows) and string-based autonomy tiers that gate execution.

The manifest registration is the _how_ (storage and lookup), while the declarative system is the _what_ (capability types and autonomy gating).

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Connector Registry and Capability Discovery](./connector-registry-and-capability-discovery.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
