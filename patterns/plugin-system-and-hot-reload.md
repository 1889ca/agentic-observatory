# Plugin System and Hot-Reload

> Manifest-driven plugin architecture with `plugin.json` discovery from both local directories and npm packages, permission-gated context injection, semver compatibility checking, and `fs.watch`-based hot-reload.

## Problem

An AI orchestrator needs to grow its capabilities without modifying core code. Hard-coding new tools, event handlers, routes, and jobs into the main application creates deployment coupling — every new capability requires a full restart and a change to the core codebase. This slows iteration and increases the blast radius of changes.

## Context

- An orchestrator that needs to support many independent capability modules
- Each plugin may contribute tools, event handlers, routes, scheduled jobs, and skill directories
- Plugins may depend on shared services (database, messenger, event bus) but access should be permission-gated
- New capabilities are added by dropping a plugin directory into `/plugins` or installing an npm package prefixed with `riley-plugin-` — no restart required
- The loader must validate the manifest schema before executing any plugin code

## Solution

### Plugin Structure

Each plugin is a directory containing a `plugin.json` manifest and a corresponding entry point. The manifest uses `main` (not `entry`) to specify the implementation file, defaulting to `index.js`:

```json
{
  "name": "github-integration",
  "version": "1.0.0",
  "main": "index.js",
  "description": "GitHub webhooks and PR tools",
  "provides": {
    "tools": ["github_pr", "github_issue"],
    "events": ["webhook.github.*"],
    "routes": [{ "method": "POST", "path": "/github/webhook" }],
    "skills": ["./skills"]
  },
  "permissions": {
    "messenger": true,
    "db": true,
    "config": ["GITHUB_TOKEN"],
    "events": ["webhook.github.*"]
  },
  "dependencies": ["core-tools@1.0.0"],
  "riley": { "minVersion": "1.0.0" }
}
```

The entry point implements lifecycle hooks. The `init` function receives a permission-gated context object:

```javascript
// plugins/github-integration/index.js
module.exports = {
  async init(ctx) {
    // ctx provides permission-gated access to services
    ctx.registerTool(
      { name: 'github_pr', description: 'Create a pull request', parameters: { /* ... */ } },
      async (args) => { /* ... */ }
    );
    ctx.registerEventHandler('webhook.github.push', handlePush);
    ctx.registerSkillsDir('./skills');
  },

  async destroy() {
    // Cleanup — called before unload or hot-reload
  },
};
```

### Multi-Source Discovery

The loader discovers plugins from two sources: the local `/plugins` directory and npm packages prefixed with `riley-plugin-` (including scoped packages like `@org/riley-plugin-*`):

```javascript
// lib/plugins/loader.js
const NPM_PLUGIN_PREFIX = 'riley-plugin-';

function loadAll() {
  const pluginsResult = loadFromPluginsDir();   // /plugins/*
  const npmResult = loadFromNodeModules();       // node_modules/riley-plugin-*

  return {
    loaded: [...pluginsResult.loaded, ...npmResult.loaded],
    failed: [...pluginsResult.failed, ...npmResult.failed],
  };
}
```

Each source is scanned for directories containing a `plugin.json`. The manifest `main` field (defaulting to `index.js`) determines which file to `require`:

```javascript
function loadFromPath(pluginPath) {
  const manifestPath = path.join(pluginPath, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: 'No plugin.json found' };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const mainFile = manifest.main || 'index.js';
  const mainPath = path.join(pluginPath, mainFile);

  delete require.cache[require.resolve(mainPath)];
  const implementation = require(mainPath);

  return registry.register(manifest, implementation, { pluginDir: pluginPath });
}
```

### Manifest Schema Validation

Before any plugin code executes, the manifest is validated against a v1.0 schema that checks `provides` and `permissions` sections. Tool names must be lowercase alphanumeric with underscores. Route definitions require valid HTTP methods. Invalid manifests are rejected before loading:

```javascript
// lib/plugins/manifest-schema.js
function validateManifestV1(manifest) {
  const errors = [];
  if (!manifest.name) errors.push('name is required');
  if (!manifest.version) errors.push('version is required');

  // Validate provides.tools, provides.routes, provides.events, provides.jobs
  const providesResult = validateProvides(manifest.provides);
  errors.push(...providesResult.errors);

  // Validate permissions: messenger (boolean), db (boolean), config (array), events (array)
  const permissionsResult = validatePermissions(manifest.permissions);
  errors.push(...permissionsResult.errors);

  return { valid: errors.length === 0, errors };
}
```

### Semver Compatibility Checking

Plugins can declare a minimum Riley version and versioned dependencies on other plugins. The registry checks semver compatibility before allowing registration:

```javascript
// lib/plugins/registry.js
function checkDependencies(manifest) {
  const missing = [];
  for (const dep of manifest.dependencies || []) {
    const [name, versionReq] = dep.split('@');
    const plugin = plugins.get(name);
    if (!plugin) { missing.push(dep); continue; }
    if (versionReq && !semver.satisfies(plugin.manifest.version, versionReq)) {
      missing.push(`${name}@${versionReq} (have ${plugin.manifest.version})`);
    }
  }
  return { satisfied: missing.length === 0, missing };
}
```

If a manifest declares `riley.minVersion`, the registry validates against the current Riley version before proceeding.

### Permission-Gated Context

Each plugin receives a context object scoped by its declared `permissions`. Services not declared in the manifest are not exposed:

```javascript
// lib/plugins/context.js
function buildContext({ manifest, pluginDir, registrations, routeManager }) {
  const permissions = manifest.permissions || {};
  const ctx = {
    manifest,
    pluginDir,
    registerTool(declaration, execute) { /* always available */ },
    registerEventHandler(event, handler) {
      // Gated: only events matching permissions.events patterns
      if (permissions.events && !matchesEventPattern(event, permissions.events)) return;
      /* ... */
    },
    registerJob(schedule, handler, options) { /* always available */ },
    registerSkillsDir(relPath) { /* registers with lib/skills */ },
    logger: buildLogger(manifest.name),
  };

  // Gated: only exposed if manifest declares permission
  if (permissions.messenger) ctx.messenger = require('../messenger');
  if (permissions.db) ctx.db = require('../db');
  if (permissions.config) ctx.config = buildConfigProxy(permissions.config);

  return ctx;
}
```

The config proxy only exposes env vars explicitly listed in `permissions.config`.

### Plugin State Machine

Plugins transition through defined lifecycle states:

```
REGISTERED → INITIALIZING → ACTIVE → ERROR → DESTROYED
```

### Dependency-Ordered Initialization

Plugins are initialized in topological order based on their declared dependencies. A plugin whose dependency is not yet `ACTIVE` will fail initialization:

```javascript
function getInitOrder() {
  const visited = new Set();
  const result = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const plugin = plugins.get(name);
    for (const dep of plugin?.manifest.dependencies || []) {
      visit(dep.split('@')[0]);
    }
    result.push(name);
  }
  for (const name of pluginOrder) visit(name);
  return result;
}
```

### Hot-Reload via File Watching

The loader uses `fs.watch` with a 500ms debounce to monitor the plugins directory. On change, it reads the `plugin.json`, unregisters the old version (calling `destroy`), clears `require.cache`, and re-loads:

```javascript
function startWatching() {
  fs.watch(PLUGINS_DIR, { recursive: true }, async (eventType, filename) => {
    // 500ms debounce to prevent cascading reloads
    const pluginDir = filename.split(path.sep)[0];
    const manifest = JSON.parse(fs.readFileSync(
      path.join(PLUGINS_DIR, pluginDir, 'plugin.json'), 'utf-8'
    ));

    const existing = registry.get(manifest.name);
    if (existing) {
      await reload(manifest.name);  // ACTIVE → DESTROYED → REGISTERED → ACTIVE
    } else {
      loadFromPath(path.join(PLUGINS_DIR, pluginDir));
      await registry.init(manifest.name);
    }
  });
}
```

## Implications

- The `plugin.json` manifest is the single source of truth for what a plugin provides — `main` (not `entry`) specifies the implementation file
- Manifest schema validation (`validateManifestV1`) catches malformed plugins before any code executes, preventing side effects from broken manifests
- Semver compatibility checking ensures plugins and their dependencies are version-compatible before initialization
- Permission gating creates a least-privilege model — plugins only access services they explicitly declare, reducing blast radius
- npm package discovery (`riley-plugin-*`) enables standard package distribution alongside local plugin development
- Hot-reload means a malformed plugin can take down registered tools mid-session — error handling during reload is critical
- The `destroy()` hook is the only cleanup mechanism — plugins that leak resources outside of what `destroy()` cleans up will cause problems on reload
- Topological ordering ensures dependencies initialize first, but circular dependencies will deadlock the init sequence

## Code Example

```javascript
// Initialize the plugin system with Express app and hot-reload
const plugins = require('./lib/plugins');

async function start(app) {
  const { loaded, failed } = await plugins.init({
    app,           // Express app for route mounting
    hotReload: true,
  });

  console.log(`Loaded ${loaded.length} plugins, ${failed.length} failed`);

  // Plugin tools are available via plugins.executeTool()
  const result = await plugins.executeTool('github_pr', { repo: 'acme/app', title: 'Fix bug' });

  // Emit events to plugin handlers
  await plugins.emitEvent('webhook.github.push', { repo: 'acme/app' });

  // List all plugins with state
  const list = plugins.listPlugins({ active: true });
  // [{ name: 'github-integration', version: '1.0.0', state: 'active', tools: 2 }]
}

// Graceful shutdown destroys plugins in reverse dependency order
process.on('SIGTERM', () => plugins.shutdown());
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
- [Unified Event System](./unified-event-system.md)
