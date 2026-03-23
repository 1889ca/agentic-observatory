# Plugin System and Hot-Reload

> Module-based plugin architecture with convention-driven discovery, standard export interface, hot-reload via file watching, and dynamic re-registration of capabilities.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Each plugin may contribute tools, event handlers, routes, and lifecycle hooks
- Plugins may depend on shared services (database, event bus, model dispatch)
- New capabilities are added by dropping a plugin module into the plugins directory — no restart required

## Solution

### Plugin Structure

Each plugin is a Node.js module that exports a standard interface. There are no manifest files — the plugin's code is its declaration. A plugin exports lifecycle hooks and capability contributions directly:

```javascript
// lib/plugins/github-integration/index.js (illustrative)
module.exports = {
  name: 'github-integration',

  // Lifecycle hooks
  async init(context) {
    // context provides access to shared services: db, eventBus, toolRegistry, router
    this.eventBus = context.eventBus;
    context.eventBus.on('webhook.github.*', this.handleWebhook);
  },

  async destroy() {
    this.eventBus.off('webhook.github.*', this.handleWebhook);
  },

  // Capability contributions
  tools: [
    {
      name: 'github_pr',
      description: 'Create or update a pull request',
      parameters: { repo: 'string', title: 'string', body: 'string' },
      handler: async (params) => { /* ... */ },
    },
    {
      name: 'github_issue',
      description: 'Create or comment on an issue',
      parameters: { repo: 'string', title: 'string' },
      handler: async (params) => { /* ... */ },
    },
  ],

  events: ['webhook.github.*'],

  routes: (router) => {
    router.post('/github/webhook', webhookHandler);
  },
};
```

### Module-Based Discovery

The loader scans for plugin modules using file and directory conventions rather than manifest files. Any directory or file in the plugins path that exports the standard interface is treated as a plugin:

```javascript
// lib/plugins/loader.js (illustrative)
async function loadAll(pluginsDir, context) {
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    const modulePath = entry.isDirectory()
      ? path.join(pluginsDir, entry.name, 'index.js')
      : path.join(pluginsDir, entry.name);

    if (!modulePath.endsWith('.js')) continue;

    try {
      const plugin = require(modulePath);
      if (!plugin.name) continue;  // Skip files that don't export the plugin interface

      await registerPlugin(plugin, context);
      loaded.set(plugin.name, { plugin, modulePath, state: 'ACTIVE' });
    } catch (err) {
      loaded.set(entry.name, { modulePath, state: 'ERROR', error: err.message });
    }
  }
}

async function registerPlugin(plugin, context) {
  // Register tool contributions directly
  if (plugin.tools) {
    for (const tool of plugin.tools) {
      context.toolRegistry.register(tool.name, tool.handler, tool);
    }
  }

  // Register event contributions
  if (plugin.events) {
    for (const pattern of plugin.events) {
      context.eventBus.register(pattern, plugin);
    }
  }

  // Mount routes
  if (plugin.routes) {
    plugin.routes(context.router);
  }

  // Call init lifecycle hook
  if (plugin.init) {
    await plugin.init(context);
  }
}
```

### Plugin State Machine

Plugins transition through defined states during their lifecycle:

```
REGISTERED → INITIALIZING → ACTIVE → ERROR → DESTROYED
```

A plugin enters `REGISTERED` when the loader discovers it, moves to `INITIALIZING` when `init()` is called, and reaches `ACTIVE` on success. If `init()` throws, the plugin transitions to `ERROR`. On unload or reload, `destroy()` is called and the plugin moves to `DESTROYED`.

### Hot-Reload via File Watching

The loader uses Node's built-in `fs.watch` to monitor the plugins directory. When a plugin file is added or modified, the loader clears `require.cache`, calls the plugin's `destroy()` hook, and re-registers the module's contributions:

```javascript
// lib/plugins/loader.js (illustrative)
function startWatching(pluginsDir, context) {
  const watcher = fs.watch(pluginsDir, { recursive: true }, async (eventType, filename) => {
    // Debounce rapid changes (500ms window)
    clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(filename, setTimeout(async () => {
      const pluginName = filename.split(path.sep)[0];
      const existing = loaded.get(pluginName);

      if (existing?.plugin?.destroy) {
        await existing.plugin.destroy();
      }

      // Clear require cache to pick up changes
      const modulePath = existing?.modulePath
        || path.join(pluginsDir, pluginName, 'index.js');
      delete require.cache[require.resolve(modulePath)];

      try {
        const plugin = require(modulePath);
        await registerPlugin(plugin, context);
        loaded.set(plugin.name, { plugin, modulePath, state: 'ACTIVE' });
      } catch (err) {
        loaded.set(pluginName, { modulePath, state: 'ERROR', error: err.message });
      }
    }, 500));
  });
}
```

The 500ms debounce window prevents cascading reloads when editors write multiple files in rapid succession (e.g., save-all). The reload cycle transitions the plugin through `ACTIVE` -> `DESTROYED` -> `REGISTERED` -> `INITIALIZING` -> `ACTIVE`, calling `destroy()` and `init()` at the appropriate points.

### Context Builder

When the LLM needs its tool declarations, the context builder aggregates across all loaded plugins:

```javascript
// lib/plugins/loader.js (illustrative)
function buildToolContext() {
  const declarations = [];
  for (const [name, entry] of loaded) {
    if (entry.state !== 'ACTIVE' || !entry.plugin.tools) continue;
    for (const tool of entry.plugin.tools) {
      declarations.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source: name,
      });
    }
  }
  return declarations;
}
```

## Implications

- Plugins can introduce bugs that affect the whole system — sandboxing is limited to process-level isolation
- Hot-reload means a malformed plugin can take down registered tools mid-session — error handling during reload is critical
- The module-based approach means plugins are plain Node.js code — no schema to learn, no manifest to maintain, but also no static validation before load
- Plugin load order may matter if plugins depend on shared state — currently resolution is load-time only with no dependency ordering
- Because plugins contribute tools and events through code rather than declarations, the set of capabilities is only fully known after all plugins have loaded and initialized
- The `destroy()` hook is the only cleanup mechanism — plugins that leak resources (open handles, intervals) outside of what `destroy()` cleans up will cause problems on reload

## Code Example

```javascript
// Full plugin lifecycle with hot-reload

// --- Loader initialization ---
const loader = {
  async init(pluginsDir, context) {
    await loadAll(pluginsDir, context);
    startWatching(pluginsDir, context);
    log.info(`Loaded ${loaded.size} plugins, ${context.toolRegistry.size} tools registered`);
  },

  async reloadPlugin(name, context) {
    // ACTIVE → DESTROYED → REGISTERED → INITIALIZING → ACTIVE
    const entry = loaded.get(name);
    if (entry?.plugin?.destroy) await entry.plugin.destroy();

    delete require.cache[require.resolve(entry.modulePath)];
    const plugin = require(entry.modulePath);
    await registerPlugin(plugin, context);
    loaded.set(name, { plugin, modulePath: entry.modulePath, state: 'ACTIVE' });
  },

  getTools() {
    return buildToolContext();
  },

  getPlugins() {
    return Array.from(loaded.entries()).map(([name, { state }]) => ({ name, state }));
  },
};

// --- Example plugin: a simple health-check tool ---
// lib/plugins/health-check/index.js
module.exports = {
  name: 'health-check',
  async init(context) {
    this.db = context.db;
  },
  async destroy() { /* nothing to clean up */ },
  tools: [
    {
      name: 'system_health',
      description: 'Check system health across all registered services',
      parameters: {},
      handler: async () => {
        // ... check DB, event bus, worker pool
        return { status: 'healthy', uptime: process.uptime() };
      },
    },
  ],
};
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
