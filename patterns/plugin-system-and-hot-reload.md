# Plugin System and Hot-Reload

> Extensible plugin architecture with directory scanning, contribution registration, hot-reload via file watching, and dynamic re-registration of capabilities.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Each plugin may contribute tools, events, scheduled jobs, and HTTP routes
- Plugins may depend on shared services (database, event bus, model dispatch)
- New capabilities are added by dropping a plugin directory — no restart required

## Solution

### Plugin Structure

Each plugin lives in its own directory with a `plugin.json` manifest that declares its metadata, dependencies, and contributions:

```json
// plugins/github-integration/plugin.json
{
  "name": "github-integration",
  "version": "1.0.0",
  "description": "GitHub webhook handling and PR/issue tools",
  "author": "team",
  "main": "index.js",
  "dependencies": ["core-tools@^1.0.0"],
  "riley": { "minVersion": "1.0.0" },
  "hooks": { "init": "setup", "destroy": "cleanup" },
  "provides": {
    "tools": ["github_pr", "github_issue"],
    "events": ["webhook.github.*"]
  },
  "permissions": {
    "events": ["plugin.*"],
    "tools": ["specific_tool"]
  }
}
```

Plugin discovery covers two locations:
- **Local:** `plugins/*` directories containing a `plugin.json` manifest
- **npm:** Packages matching `riley-plugin-*` or `@org/riley-plugin-*` in `node_modules`

Plugins transition through defined states: `REGISTERED` → `INITIALIZING` → `ACTIVE` → `ERROR` → `DESTROYED`.

### Plugin Registry

The registry scans the plugin directory, parses each `plugin.json` manifest, and loads the module entry point:

```javascript
async function loadAll() {
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, entry.name, 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const plugin = require(path.join(PLUGINS_DIR, entry.name, manifest.main));

    // Register contributions declared in the manifest
    manifest.provides?.tools?.forEach(t => toolRegistry.register(t, plugin));
    manifest.provides?.events?.forEach(e => eventBus.register(e, plugin));

    loaded.set(manifest.name, { manifest, plugin, state: 'ACTIVE' });
  }
}
```

Core lifecycle functions: `loadAll()`, `reload(name)`, `startWatching()`, `stopWatching()`.

### Context Builder

When the LLM needs its tool declarations, the context builder aggregates across all loaded plugins:

```javascript
function buildToolContext() {
  const declarations = [];
  for (const [name, plugin] of loaded) {
    for (const tool of plugin.tools || []) {
      declarations.push({
        name: tool.name,
        description: tool.schema.description,
        parameters: tool.schema.parameters,
        source: name  // Track which plugin provides each tool
      });
    }
  }
  return declarations;
}
```

### Hot-Reload via File Watching

The plugin loader uses Node's built-in `fs.watch` (no external dependencies) to monitor the plugins directory. When a plugin file is added or modified, the loader parses the `plugin.json` manifest, clears `require.cache`, and re-registers the plugin's contributions:

```javascript
function startWatching() {
  const watcher = fs.watch(PLUGINS_DIR, { recursive: true }, async (eventType, filename) => {
    // Debounce rapid changes (500ms window)
    clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(filename, setTimeout(async () => {
      // Find plugin dir from filename
      const pluginName = filename.split(path.sep)[0];
      const manifestPath = path.join(PLUGINS_DIR, pluginName, 'plugin.json');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));

      if (loaded.has(pluginName)) {
        await reload(pluginName);
      } else {
        await init(pluginName);
      }
    }, 500));
  });
}
```

The 500ms debounce window prevents cascading reloads when editors write multiple files in rapid succession (e.g., save-all). The `reload()` function transitions the plugin through `DESTROYED` → `REGISTERED` → `INITIALIZING` → `ACTIVE`, calling the manifest's `hooks.destroy` and `hooks.init` handlers at the appropriate points.

## Implications

- Plugins can introduce bugs that affect the whole system — sandboxing is limited to process-level isolation
- Hot-reload means a malformed plugin can take down registered tools mid-session — error handling during reload is critical
- Route mounting at `/api/plugins/{name}/*` creates a clean namespace but limits URL flexibility
- The registry pattern means all plugins must conform to a fixed interface — ad-hoc extensions are not supported
- Plugin load order may matter if plugins depend on each other — the `dependencies` field in `plugin.json` declares requirements but resolution is load-time only

## Code Example

```javascript
// Full plugin lifecycle with hot-reload
const pluginManager = {
  async init() {
    await loadAll();
    startWatching();
    log.info(`Loaded ${loaded.size} plugins with ${toolRegistry.size} tools (watching for changes)`);
  },

  async reloadPlugin(name) {
    await reload(name);  // ACTIVE → DESTROYED → REGISTERED → INITIALIZING → ACTIVE
  },

  stopWatching() {
    stopWatching();
  },

  getTools() {
    return buildToolContext();
  },

  getPlugins() {
    return Array.from(loaded.entries()).map(([name, { state }]) => ({ name, state }));
  }
};
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
