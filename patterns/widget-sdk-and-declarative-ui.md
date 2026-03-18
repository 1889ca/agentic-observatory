# Widget SDK and Declarative UI

> JSON-based UI primitive system where agents emit pure data structures instead of markup, and the host runtime resolves, binds, and renders them.

## Problem

When agents generate user-facing interfaces, the naive approach is to have them emit HTML or React components directly. This creates tight coupling between the agent layer and the rendering layer — agents need to know about CSS classes, component libraries, and framework-specific idioms. It also opens the door to injection attacks (agents crafting malicious markup) and makes it impossible to render agent output in different contexts (web, mobile, CLI, notification card) without per-agent adaptation.

## Context

- An orchestrator or agent system that needs to present structured information to users
- Multiple agents produce UI, each with different data shapes
- The rendering target may change (web today, mobile tomorrow, Slack cards next week)
- Agents should focus on *what* to display, not *how* to display it
- Widget types need to be extensible without modifying every agent

## Solution

### UI Primitive Registry

A fixed set of UI primitives defines the vocabulary agents can use. Each primitive has a type name, a props schema, and optional children. The primitives are deliberately minimal — enough to compose any common layout, but not so many that agents need a design degree:

```javascript
// widget-sdk/primitives.js
const PRIMITIVES = {
  Text:   { props: ['value', 'variant'], variants: ['heading', 'body', 'caption', 'code'] },
  Stack:  { props: ['direction', 'gap', 'align'], children: true },
  Card:   { props: ['title', 'padding', 'elevation'], children: true },
  List:   { props: ['items', 'ordered'], children: false },
  Badge:  { props: ['label', 'color', 'icon'], children: false },
  Button: { props: ['label', 'action', 'variant'], children: false },
  Input:  { props: ['placeholder', 'type', 'bind'], children: false },
  Image:  { props: ['src', 'alt', 'width', 'height'], children: false },
};
```

### Template Binding

Widget definitions use `{{variable}}` syntax for dynamic data. The binding engine resolves these against a data context at render time, keeping the widget definition static and reusable:

```javascript
// widget-sdk/bind.js
function bindTemplate(widget, data) {
  const bound = { type: widget.type, props: {} };

  for (const [key, value] of Object.entries(widget.props || {})) {
    if (typeof value === 'string' && value.includes('{{')) {
      bound.props[key] = value.replace(/\{\{(\w+)\}\}/g, (_, name) => data[name] ?? '');
    } else {
      bound.props[key] = value;
    }
  }

  if (widget.children) {
    bound.children = widget.children.map(child => bindTemplate(child, data));
  }

  return bound;
}
```

### Widget Type Registry

Entity types map to widget configurations, so the system knows how to render a "task", "project", or "alert" without the agent specifying layout every time:

```javascript
// widget-sdk/registry.js
const widgetRegistry = new Map();

function registerWidget(entityType, widgetDef) {
  widgetRegistry.set(entityType, widgetDef);
}

function resolveWidget(entityType, data) {
  const def = widgetRegistry.get(entityType);
  if (!def) return null;
  return bindTemplate(def, data);
}

// Registration at startup
registerWidget('task', {
  type: 'Card',
  children: [
    { type: 'Text', props: { value: '{{title}}', variant: 'heading' } },
    { type: 'Stack', props: { direction: 'horizontal', gap: 8 },
      children: [
        { type: 'Badge', props: { label: '{{status}}', color: '{{statusColor}}' } },
        { type: 'Text', props: { value: '{{description}}', variant: 'body' } },
      ]
    }
  ]
});
```

### Agent Output as Pure Data

Agents never touch rendering. They return a widget type and the data to fill it:

```javascript
// Inside an agent tool handler
async function handleShowTask(args) {
  const task = await db.getTask(args.taskId);

  return {
    widget: 'task',
    data: {
      title: task.name,
      status: task.status,
      statusColor: task.status === 'done' ? 'green' : 'amber',
      description: task.summary,
    }
  };
}
```

### Rendering Layer

The renderer is a thin mapping from bound widget trees to platform-specific components. Swapping renderers changes the target without touching agent code or widget definitions:

```javascript
// ui/renderers/react-renderer.js
const componentMap = {
  Text:  ({ value, variant }) => <span className={`text-${variant}`}>{value}</span>,
  Stack: ({ direction, gap, children }) => (
    <div style={{ display: 'flex', flexDirection: direction === 'horizontal' ? 'row' : 'column', gap }}>
      {children}
    </div>
  ),
  Card:  ({ title, children }) => <div className="card"><h3>{title}</h3>{children}</div>,
  Badge: ({ label, color }) => <span className="badge" style={{ background: color }}>{label}</span>,
};

function renderWidget(widget) {
  const Component = componentMap[widget.type];
  if (!Component) return null;

  const childElements = widget.children?.map((child, i) => renderWidget(child));
  return <Component key={widget.type} {...widget.props}>{childElements}</Component>;
}
```

## Implications

- Agents are completely decoupled from rendering — they produce JSON, not markup
- New UI primitives require updating both the primitive registry and every renderer, so the set should grow conservatively
- Template binding is intentionally simple (no expressions, no conditionals) — complex display logic belongs in the renderer, not the widget definition
- The registry pattern means common entity types get consistent presentation across all agents without coordination
- Validation is straightforward — widget output can be schema-checked before rendering, catching malformed agent output early
- No risk of injection attacks since agents never produce executable markup
- Adding a new rendering target (CLI, Slack, email) only requires a new renderer mapping, not changes to any agent

## Code Example

```javascript
// End-to-end: agent produces widget, system resolves and renders
const agentOutput = await agent.run('show me the deployment status');

// agentOutput = { widget: 'deployment', data: { env: 'prod', status: 'healthy', uptime: '14d' } }

const widgetTree = resolveWidget(agentOutput.widget, agentOutput.data);

// widgetTree is now a fully bound JSON tree:
// {
//   type: 'Card',
//   props: {},
//   children: [
//     { type: 'Text', props: { value: 'prod', variant: 'heading' } },
//     { type: 'Badge', props: { label: 'healthy', color: 'green' } },
//     { type: 'Text', props: { value: 'Uptime: 14d', variant: 'caption' } }
//   ]
// }

const reactElement = renderWidget(widgetTree);
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
