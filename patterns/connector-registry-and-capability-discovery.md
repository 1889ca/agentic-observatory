# Connector Registry and Capability Discovery

> Generic connector pattern for external services with type registry, instance caching, capability querying, and priority-based selection.

## Problem

An orchestrator integrates with many external services — calendars, project trackers, code hosts, CRMs. Each integration has different authentication flows, API endpoints, and capabilities. Without a registry, connector code is scattered across the codebase and duplicated between similar services. Adding a new service means touching multiple files: routing logic, initialization, capability mapping, and cleanup. The result is tight coupling between the orchestrator's core and every service it talks to.

## Context

- An AI agent or orchestrator that interacts with external services on behalf of users or tenants
- Multiple services may fulfill the same role (e.g., GitHub and GitLab are both code hosts)
- Connectors hold state — auth tokens, WebSocket connections, cached data — that must be managed per tenant
- The orchestrator needs to ask "who can do X?" without hardcoding which service handles what
- New integrations should be addable without modifying core orchestrator code

## Solution

### Base Connector Contract

An abstract base class defines the interface every connector must implement. This guarantees the orchestrator can interact with any connector uniformly, regardless of the underlying service:

```javascript
class BaseConnector {
  constructor(config) {
    this.config = config;
    this.connected = false;
  }

  async connect() {
    throw new Error('Subclass must implement connect()');
  }

  async disconnect() {
    throw new Error('Subclass must implement disconnect()');
  }

  async query(operation, params) {
    throw new Error('Subclass must implement query()');
  }

  getCapabilities() {
    // Returns array of capability strings this connector supports
    throw new Error('Subclass must implement getCapabilities()');
  }

  getPriority() {
    // Higher priority wins when multiple connectors support the same capability
    return 0;
  }
}
```

Concrete connectors extend this base and declare what they can do:

```javascript
class GitHubConnector extends BaseConnector {
  async connect() {
    this.client = new Octokit({ auth: this.config.token });
    this.connected = true;
  }

  async disconnect() {
    this.client = null;
    this.connected = false;
  }

  getCapabilities() {
    return ['list-repos', 'create-issue', 'create-pr', 'list-prs', 'get-commit-history'];
  }

  getPriority() {
    return 10; // Preferred code host
  }

  async query(operation, params) {
    switch (operation) {
      case 'list-repos':
        return this.client.repos.listForAuthenticatedUser(params);
      case 'create-issue':
        return this.client.issues.create(params);
      // ...
    }
  }
}
```

### Type Registry

A central registry maps service types (e.g., "code-host", "calendar") to connector implementations. Multiple implementations can register under the same type:

```javascript
class ConnectorRegistry {
  constructor() {
    this.types = new Map();       // type -> [ConnectorClass, ...]
    this.instances = new Map();   // tenantId:type:implName -> instance
  }

  registerType(type, ConnectorClass, name) {
    if (!this.types.has(type)) this.types.set(type, []);
    this.types.get(type).push({ name, ConnectorClass });
  }
}

// Registration at startup
registry.registerType('code-host', GitHubConnector, 'github');
registry.registerType('code-host', GitLabConnector, 'gitlab');
registry.registerType('calendar', GoogleCalendarConnector, 'google-calendar');
registry.registerType('project-tracker', LinearConnector, 'linear');
```

### Instance Caching

Connector instances are cached per tenant to avoid re-authenticating on every request. Initialization is lazy — connectors aren't created until first use:

```javascript
async getInstance(tenantId, type, implName, config) {
  const key = `${tenantId}:${type}:${implName}`;

  if (this.instances.has(key)) {
    return this.instances.get(key);
  }

  const entry = this.types.get(type)?.find(t => t.name === implName);
  if (!entry) throw new Error(`Unknown connector: ${type}/${implName}`);

  const instance = new entry.ConnectorClass(config);
  await instance.connect();
  this.instances.set(key, instance);
  return instance;
}

async removeTenant(tenantId) {
  for (const [key, instance] of this.instances) {
    if (key.startsWith(`${tenantId}:`)) {
      await instance.disconnect();
      this.instances.delete(key);
    }
  }
}
```

### Capability Discovery

Each connector declares its capabilities. The registry aggregates these to answer "who can do X?" across all registered connectors for a given tenant:

```javascript
getCapabilities(tenantId) {
  const caps = new Map(); // capability -> [{ type, name, priority }]

  for (const [key, instance] of this.instances) {
    if (!key.startsWith(`${tenantId}:`)) continue;
    const [, type, name] = key.split(':');

    for (const cap of instance.getCapabilities()) {
      if (!caps.has(cap)) caps.set(cap, []);
      caps.get(cap).push({ type, name, priority: instance.getPriority() });
    }
  }

  return caps;
}
```

### Resolver

Given a capability request, the resolver finds all connectors that support it and selects the best one based on priority:

```javascript
async resolve(tenantId, capability, params) {
  const caps = this.getCapabilities(tenantId);
  const providers = caps.get(capability);

  if (!providers || providers.length === 0) {
    throw new Error(`No connector supports capability: ${capability}`);
  }

  // Sort by priority descending, pick the best
  providers.sort((a, b) => b.priority - a.priority);
  const best = providers[0];

  const key = `${tenantId}:${best.type}:${best.name}`;
  const instance = this.instances.get(key);
  return instance.query(capability, params);
}
```

## Implications

- Adding a new service is a single file: implement the connector class, register its type at startup. No changes to orchestrator core.
- Capability discovery lets the agent ask "who can create issues?" without knowing whether the tenant uses GitHub, GitLab, or Linear. The resolver handles the mapping.
- Instance caching means connectors hold state (connections, tokens, caches). Tenant removal must walk the instance cache and disconnect everything, or you leak connections.
- Priority-based selection is simple but limited. It doesn't account for rate limits, current availability, or cost. A more sophisticated resolver might consider load or health checks.
- Multiple connectors for the same capability can cause ambiguity. The priority system resolves this deterministically, but operators need to set priorities intentionally.
- Lazy initialization means the first request for a connector type is slower (auth handshake, connection setup). Subsequent requests hit the cache.

## Code Example

```javascript
// Full lifecycle: register, connect, discover, resolve

const registry = new ConnectorRegistry();

// Register available connector types
registry.registerType('code-host', GitHubConnector, 'github');
registry.registerType('code-host', GitLabConnector, 'gitlab');
registry.registerType('project-tracker', LinearConnector, 'linear');

// Tenant onboarding — lazy, connectors init on first use
await registry.getInstance('tenant-42', 'code-host', 'github', {
  token: tenantConfig.githubToken,
});
await registry.getInstance('tenant-42', 'project-tracker', 'linear', {
  apiKey: tenantConfig.linearKey,
});

// Agent asks: "what can I do for this tenant?"
const capabilities = registry.getCapabilities('tenant-42');
// Map { 'list-repos' => [...], 'create-issue' => [...], 'create-pr' => [...], ... }

// Agent resolves a capability without knowing which service backs it
const issues = await registry.resolve('tenant-42', 'create-issue', {
  title: 'Fix login bug',
  body: 'Users report 500 on /auth/callback',
});

// Tenant offboarding — clean up all connections
await registry.removeTenant('tenant-42');
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Plugin System and Hot-Reload](./plugin-system-and-hot-reload.md)
