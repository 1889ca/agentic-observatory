# Plugin System and Hot-Reload

> Extensible plugin architecture with file watching, context building, and graceful lifecycle management.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Desire to add, update, or remove capabilities without restarting the system
- Each plugin may contribute tools, events, scheduled jobs, and HTTP routes
- Plugins may depend on shared services (database, event bus, model dispatch)
- Development workflow benefits from live-reload during iteration

## Solution

### Plugin Structure

Each plugin lives in its own directory with a standard entry point:

```javascript
// plugins/github-integration/index.js
module.exports = {
  name: 'github-integration',
  version: '1.0.0',

  tools: [
    { name: 'github_pr', handler: handlePR, schema: prSchema },
    { name: 'github_issue', handler: handleIssue, schema: issueSchema }
  ],

  events: [
    { event: 'webhook:github', handler: onGithubWebhook }
  ],

  jobs: [
    { id: 'github-sync', schedule: '*/30 * * * *', handler: syncRepos }
  ],

  routes: (router) => {
    router.post('/webhook', handleWebhook);
  }
};
```

### Plugin Registry

The registry scans the plugin directory, loads each plugin, and builds a unified context:

```javascript
async function loadPlugins(pluginDir) {
  const entries = await fs.readdir(pluginDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = require(path.join(pluginDir, entry.name));

    // Register each contribution type
    manifest.tools?.forEach(t => toolRegistry.register(t));
    manifest.events?.forEach(e => eventBus.on(e.event, e.handler));
    manifest.jobs?.forEach(j => scheduler.register(j));

    if (manifest.routes) {
      const router = express.Router();
      manifest.routes(router);
      app.use(`/api/plugins/${manifest.name}`, router);
    }

    loaded.set(manifest.name, manifest);
  }
}
```

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

### File Watching and Hot-Reload

A file watcher monitors the plugin directory for changes:

```javascript
const watcher = fs.watch(pluginDir, { recursive: true }, async (event, filename) => {
  const pluginName = filename.split(path.sep)[0];
  if (!loaded.has(pluginName)) return;

  // Graceful unload
  await unloadPlugin(pluginName);

  // Clear require cache
  delete require.cache[require.resolve(path.join(pluginDir, pluginName))];

  // Reload
  await loadPlugin(pluginName);
  log.info(`Hot-reloaded plugin: ${pluginName}`);
});
```

### Graceful Shutdown

When a plugin is unloaded (for reload or removal), its contributions are cleanly removed:

```javascript
async function unloadPlugin(name) {
  const plugin = loaded.get(name);
  if (!plugin) return;

  plugin.tools?.forEach(t => toolRegistry.unregister(t.name));
  plugin.events?.forEach(e => eventBus.off(e.event, e.handler));
  plugin.jobs?.forEach(j => scheduler.unregister(j.id));

  // Route cleanup handled by removing the mounted router
  loaded.delete(name);
}
```

## Implications

- Plugins can introduce bugs that affect the whole system — sandboxing is limited to process-level isolation
- Hot-reload clears the require cache, which can cause issues with stateful plugins that hold connections
- Route mounting at `/api/plugins/{name}/*` creates a clean namespace but limits URL flexibility
- The registry pattern means all plugins must conform to a fixed interface — ad-hoc extensions are not supported
- File watching adds filesystem overhead proportional to the number of watched files
- Plugin load order may matter if plugins depend on each other — no dependency resolution is built in

## Code Example

```javascript
// Full plugin lifecycle
const pluginManager = {
  async init(pluginDir) {
    await loadPlugins(pluginDir);
    startFileWatcher(pluginDir);
    log.info(`Loaded ${loaded.size} plugins with ${toolRegistry.size} tools`);
  },

  getTools() {
    return buildToolContext();
  },

  async reload(pluginName) {
    await unloadPlugin(pluginName);
    await loadPlugin(pluginName);
  },

  async shutdown() {
    for (const [name] of loaded) {
      await unloadPlugin(name);
    }
    watcher.close();
  }
};
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
