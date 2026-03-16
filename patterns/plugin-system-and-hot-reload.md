# Plugin System and Startup Loading

> Extensible plugin architecture with directory scanning, contribution registration, and context building at startup.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Each plugin may contribute tools, events, scheduled jobs, and HTTP routes
- Plugins may depend on shared services (database, event bus, model dispatch)
- New capabilities are added by dropping a plugin directory and restarting

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

### Startup-Only Loading

Plugins are loaded once at startup. There is no file watcher or hot-reload mechanism — adding or modifying a plugin requires a restart. This keeps the plugin lifecycle simple and avoids the complexity of clearing `require.cache`, managing stateful teardown, or handling partial reloads of plugins that hold connections.

## Implications

- Plugins can introduce bugs that affect the whole system — sandboxing is limited to process-level isolation
- Adding or updating a plugin requires a restart, which is acceptable for an orchestrator that starts up quickly
- Route mounting at `/api/plugins/{name}/*` creates a clean namespace but limits URL flexibility
- The registry pattern means all plugins must conform to a fixed interface — ad-hoc extensions are not supported
- Plugin load order may matter if plugins depend on each other — no dependency resolution is built in

## Code Example

```javascript
// Full plugin lifecycle
const pluginManager = {
  async init(pluginDir) {
    await loadPlugins(pluginDir);
    log.info(`Loaded ${loaded.size} plugins with ${toolRegistry.size} tools`);
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
