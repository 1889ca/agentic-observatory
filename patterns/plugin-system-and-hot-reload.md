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

### Hot-Reload via File Watching

The plugin loader watches the plugins directory for changes. When a plugin file is added or modified, the loader clears `require.cache` for the changed module, re-requires it, and dynamically re-registers its tools, events, jobs, and routes:

```javascript
const chokidar = require('chokidar');

function watchPlugins(pluginDir) {
  const watcher = chokidar.watch(pluginDir, { ignoreInitial: true });

  watcher.on('change', async (filePath) => {
    const pluginName = path.basename(path.dirname(filePath));
    log.info(`Plugin changed: ${pluginName}, reloading...`);

    // Clear cached module so require() picks up the new version
    const modulePath = require.resolve(path.join(pluginDir, pluginName));
    delete require.cache[modulePath];

    // Unregister old contributions
    const old = loaded.get(pluginName);
    if (old) {
      old.tools?.forEach(t => toolRegistry.unregister(t.name));
      old.events?.forEach(e => eventBus.off(e.event, e.handler));
      old.jobs?.forEach(j => scheduler.unregister(j.id));
      if (old.routes) routeManager.unmount(`/api/plugins/${pluginName}`);
    }

    // Re-require and re-register
    const manifest = require(modulePath);
    manifest.tools?.forEach(t => toolRegistry.register(t));
    manifest.events?.forEach(e => eventBus.on(e.event, e.handler));
    manifest.jobs?.forEach(j => scheduler.register(j));

    if (manifest.routes) {
      const router = express.Router();
      manifest.routes(router);
      routeManager.mount(`/api/plugins/${manifest.name}`, router);
    }

    loaded.set(manifest.name, manifest);
    log.info(`Plugin reloaded: ${pluginName}`);
  });

  watcher.on('add', async (filePath) => {
    // New plugin directory detected — load it
    const pluginName = path.basename(path.dirname(filePath));
    if (!loaded.has(pluginName)) {
      await loadPlugin(pluginDir, pluginName);
    }
  });
}
```

The route-manager handles dynamic mount/unmount of plugin routes so Express does not accumulate stale route handlers on reload.

## Implications

- Plugins can introduce bugs that affect the whole system — sandboxing is limited to process-level isolation
- Hot-reload means a malformed plugin can take down registered tools mid-session — error handling during reload is critical
- Route mounting at `/api/plugins/{name}/*` creates a clean namespace but limits URL flexibility
- The registry pattern means all plugins must conform to a fixed interface — ad-hoc extensions are not supported
- Plugin load order may matter if plugins depend on each other — no dependency resolution is built in

## Code Example

```javascript
// Full plugin lifecycle with hot-reload
const pluginManager = {
  async init(pluginDir) {
    await loadPlugins(pluginDir);
    watchPlugins(pluginDir);
    log.info(`Loaded ${loaded.size} plugins with ${toolRegistry.size} tools (watching for changes)`);
  },

  getTools() {
    return buildToolContext();
  },

  getPlugins() {
    return Array.from(loaded.keys());
  }
};
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Unified Event System](./unified-event-system.md)
