# Plugin System and Hot-Reload

> Manifest-driven plugin architecture where each plugin declares its name, capabilities, dependencies, and lifecycle hooks in a `plugin.json` file, which the loader reads to determine what to load and register.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Each plugin may contribute tools, event handlers, routes, and lifecycle hooks
- Plugins may depend on shared services (database, event bus, model dispatch)
- New capabilities are added by dropping a plugin directory into the plugins directory — no restart required
- The loader must know what a plugin provides before executing any of its code

## Solution

### Plugin Structure

Each plugin is a directory containing a `plugin.json` manifest and a corresponding entry point. The manifest is the authoritative declaration of the plugin's identity, capabilities, and dependencies. The loader reads `plugin.json` first to decide whether and how to load the plugin:

```json
// lib/plugins/github-integration/plugin.json (illustrative)
{
  "name": "github-integration",
  "version": "1.0.0",
  "entry": "index.js",
  "capabilities": {
    "tools": ["github_pr", "github_issue"],
    "events": ["webhook.github.*"],
    "routes": ["/github/webhook"]
  },
  "dependencies": ["event-bus", "tool-registry"],
  "hooks": {
    "init": true,
    "destroy": true
  }
}
```

The entry point implements the lifecycle hooks declared in the manifest:

```javascript
// lib/plugins/github-integration/index.js (illustrative)
module.exports = {
  async init(context) {
    // context provides access to shared services: db, eventBus, toolRegistry, router
    this.eventBus = context.eventBus;
    context.eventBus.on('webhook.github.*', this.handleWebhook);
  },

  async destroy() {
    this.eventBus.off('webhook.github.*', this.handleWebhook);
  },

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

  routes: (router) => {
    router.post('/github/webhook', webhookHandler);
  },
};
```

### Manifest-Based Discovery

The loader scans the plugins directory for subdirectories containing a `plugin.json` file. Only directories with a valid manifest are treated as plugins — file conventions alone are not sufficient. The manifest is parsed and validated before any plugin code is executed:

```javascript
// lib/plugins/loader.js (illustrative)
async function loadAll(pluginsDir, context) {
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'plugin.json');

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      // No plugin.json or invalid JSON — not a plugin directory, skip silently
      continue;
    }

    // Validate required manifest fields before loading any code
    if (!manifest.name || !manifest.entry) {
      loaded.set(entry.name, { manifestPath, state: 'ERROR', error: 'Invalid manifest' });
      continue;
    }

    const entryPath = path.join(pluginsDir, entry.name, manifest.entry);

    try {
      const plugin = require(entryPath);
      await registerPlugin(manifest, plugin, context);
      loaded.set(manifest.name, { manifest, plugin, entryPath, state: 'ACTIVE' });
    } catch (err) {
      loaded.set(manifest.name, { manifest, entryPath, state: 'ERROR', error: err.message });
    }
  }
}

async function registerPlugin(manifest, plugin, context) {
  // Register tool contributions declared in the manifest
  if (manifest.capabilities?.tools && plugin.tools) {
    for (const tool of plugin.tools) {
      context.toolRegistry.register(tool.name, tool.handler, tool);
    }
  }

  // Register event patterns declared in the manifest
  if (manifest.capabilities?.events && plugin.events) {
    for (const pattern of plugin.events) {
      context.eventBus.register(pattern, plugin);
    }
  }

  // Mount routes declared in the manifest
  if (manifest.capabilities?.routes && plugin.routes) {
    plugin.routes(context.router);
  }

  // Call init lifecycle hook if declared
  if (manifest.hooks?.init && plugin.init) {
    await plugin.init(context);
  }
}
```

### Dependency Resolution

Because manifests declare dependencies explicitly, the loader can resolve load order before executing any plugin code. Plugins whose dependencies are not yet active are deferred until their dependencies initialize:

```javascript
// lib/plugins/loader.js (illustrative)
function resolveDependencyOrder(manifests) {
  // Topological sort based on manifest.dependencies arrays
  // Returns an ordered list of plugin names safe to initialize sequentially
}
```

### Plugin State Machine

Plugins transition through defined states during their lifecycle:

```
REGISTERED → INITIALIZING → ACTIVE → ERROR → DESTROYED
```

A plugin enters `REGISTERED` when the loader validates its manifest, moves to `INITIALIZING` when `init()` is called, and reaches `ACTIVE` on success. If `init()` throws, the plugin transitions to `ERROR`. On unload or reload, `destroy()` is called and the plugin moves to `DESTROYED`.

### Hot-Reload via File Watching

The loader uses Node's built-in `fs.watch` to monitor the plugins directory. When a file is added or modified within a plugin directory, the loader re-reads the `plugin.json` manifest first, then clears `require.cache`, calls the plugin's `destroy()` hook, and re-registers the plugin using the updated manifest and code:

```javascript
// lib/plugins/loader.js (illustrative)
function startWatching(pluginsDir, context) {
  const watcher = fs.watch(pluginsDir, { recursive: true }, async (eventType, filename) => {
    // Debounce rapid changes (500ms window)
    clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(filename, setTimeout(async () => {
      const pluginName = filename.split(path.sep)[0];
      const existing = loaded.get(pluginName);

      if (existing?.plugin?.destroy && existing.manifest?.hooks?.destroy) {
        await existing.plugin.destroy();
      }

      const manifestPath = path.join(pluginsDir, pluginName, 'plugin.json');
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      } catch {
        loaded.set(pluginName, { state: 'ERROR', error: 'Manifest unreadable after reload' });
        return;
      }

      const entryPath = path.join(pluginsDir, pluginName, manifest.entry);
      delete require.cache[require.resolve(entryPath)];

      try {
        const plugin = require(entryPath);
        await registerPlugin(manifest, plugin, context);
        loaded.set(manifest.name, { manifest, plugin, entryPath, state: 'ACTIVE' });
      } catch (err) {
        loaded.set(pluginName, { manifestPath, entryPath, state: 'ERROR', error: err.message });
      }
    }, 500));
  });
}
```

The 500ms debounce window prevents cascading reloads when editors write multiple files in rapid succession. The reload cycle transitions the plugin through `ACTIVE` -> `DESTROYED` -> `REGISTERED` -> `INITIALIZING` -> `ACTIVE`, calling `destroy()` and `init()` at the appropriate points.

### Context Builder

When the LLM needs its tool declarations, the context builder aggregates across all loaded plugins. Because the manifest declares capabilities statically, the loader can also report what a plugin contributes even before its code has fully initialized:

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

- The `plugin.json` manifest is the single source of truth for what a plugin provides — mismatches between the manifest and the entry point code are a class of bugs to guard against
- Manifest validation happens before code execution, so malformed or incomplete plugins fail early without side effects
- Dependency ordering is possible because dependencies are declared statically in manifests, not inferred from code exports at runtime
- Hot-reload means a malformed plugin can take down registered tools mid-session — error handling during reload is critical
- The `destroy()` hook is the only cleanup mechanism — plugins that leak resources (open handles, intervals) outside of what `destroy()` cleans up will cause problems on reload
- Adding a plugin is a matter of dropping a directory with a valid `plugin.json` — no changes to core code required, but the manifest schema must be understood by the plugin author

## Code Example

```javascript
// Full plugin lifecycle with manifest-based loading and hot-reload

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
    if (entry?.plugin?.destroy && entry.manifest?.hooks?.destroy) {
      await entry.plugin.destroy();
    }

    // Re-read manifest in case it changed
    const manifest = JSON.parse(await fs.readFile(
      path.join(pluginsDir, name, 'plugin.json'), 'utf8'
    ));
    const entryPath = path.join(pluginsDir, name, manifest.entry);
    delete require.cache[require.resolve(entryPath)];

    const plugin = require(entryPath);
    await registerPlugin(manifest, plugin, context);
    loaded.set(name, { manifest, plugin, entryPath, state: 'ACTIVE' });
  },

  getTools() {
    return buildToolContext();
  },

  getPlugins() {
    return Array.from(loaded.entries()).map(([name, { manifest, state }]) => ({
      name,
      version: manifest?.version,
      capabilities: manifest?.capabilities,
      state,
    }));
  },
};

// --- Example plugin manifest ---
// lib/plugins/health-check/plugin.json
// {
//   "name": "health-check",
//   "version": "1.0.0",
//   "entry": "index.js",
//   "capabilities": { "tools": ["system_health"] },
//   "dependencies": ["db"],
//   "hooks": { "init": true, "destroy": false }
// }

// --- Example plugin entry point ---
// lib/plugins/health-check/index.js
module.exports = {
  async init(context) {
    this.db = context.db;
  },
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
