# Connector Registry and Capability Discovery

> Aspirational pattern for unified external service integration — describes the concept of a connector registry with capability discovery, and how the system currently handles integrations without one.

## Problem

An orchestrator integrates with many external services — calendars, project trackers, code hosts, messaging platforms. Each integration has different authentication flows, API endpoints, and capabilities. Without a registry, connector code is scattered across the codebase with no shared interface. Adding a new service means building it from scratch, and the orchestrator can't ask "who can do X?" without hardcoding which service handles what.

## Context

> **Implementation status:** This pattern is aspirational. Riley does not currently implement a unified connector registry. External service integrations are handled through direct per-service modules.

- An AI agent that interacts with external services on behalf of users
- Multiple services may fulfill the same role (e.g., GitHub and GitLab are both code hosts)
- New integrations are added over time as the system gains capabilities
- The current approach works but doesn't scale cleanly

## Solution

### Current Reality: Direct Per-Service Modules

Riley currently integrates with external services through individual modules, each with its own initialization, authentication, and API patterns. There is no shared base class, no type registry, and no capability discovery:

```javascript
// Current: each service is its own module with bespoke integration
// telegram/index.js
function initTelegram(config) {
  const bot = new TelegramBot(config.token);
  return { sendMessage, onMessage, ... };
}

// github/index.js
function initGitHub(config) {
  const client = new Octokit({ auth: config.token });
  return { createPR, listRepos, ... };
}

// No shared interface, no registry, no capability queries
```

This approach is straightforward but has limitations:

- Adding a new service requires wiring it into every consumer that needs it
- There's no way to ask "which services can create issues?" at runtime
- Swapping one service for another (e.g., GitHub for GitLab) requires changing call sites

### Aspirational: Unified Connector Registry

The intended pattern would introduce a registry where connectors declare their capabilities and the orchestrator resolves capability requests without knowing which service backs them:

```javascript
// Aspirational connector contract
class BaseConnector {
  async connect() { /* auth and init */ }
  async disconnect() { /* cleanup */ }
  async query(operation, params) { /* execute */ }
  getCapabilities() { /* return capability strings */ }
}

// Registry maps types to implementations
registry.register('code-host', GitHubConnector);
registry.register('code-host', GitLabConnector);

// Capability resolution
const result = await registry.resolve('create-issue', params);
// → routes to whichever code-host connector is configured
```

### Key Design Elements

The aspirational pattern includes several features not yet implemented:

- **Type registry** — maps service categories (code-host, calendar) to connector implementations
- **Instance caching** — lazy initialization with per-tenant connector instances cached after first use
- **Capability discovery** — each connector declares what it can do, and the registry aggregates capabilities across all connectors
- **Priority-based resolution** — when multiple connectors support the same capability, the highest-priority one is selected

## Implications

- The current per-service approach is simple and debuggable — each module is self-contained with no abstraction overhead
- Without a registry, the orchestrator must know at development time which service handles each capability
- A future registry would decouple the orchestrator from specific services, making it easier to swap providers or support multiple simultaneously
- The registry pattern adds indirection that can make debugging harder — a failed `create-issue` call would need tracing through the resolver to find which connector handled it
- Instance caching in a registry must handle token expiry, connection drops, and tenant removal — each a source of subtle bugs
- Migration from direct modules to a registry is incremental: existing modules can be wrapped as connectors without rewriting their internals

## Code Example

```javascript
// Current: direct service usage (what Riley actually does)
const github = initGitHub({ token: config.githubToken });
const issues = await github.createIssue({ title, body });

// Aspirational: registry-based resolution (not yet implemented)
// const issues = await registry.resolve('create-issue', { title, body });
// → would route to GitHub, GitLab, or Linear based on configuration
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Plugin System and Hot-Reload](./plugin-system-and-hot-reload.md)
