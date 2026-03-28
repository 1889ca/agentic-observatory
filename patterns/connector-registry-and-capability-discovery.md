# Connector Registry and Capability Discovery

> Fully implemented connector system with a base class, auto-loading implementation directory, per-tenant instance caching, and a priority-based resolver that routes operations to the best available connector.

## Problem

An orchestrator integrates with many external services -- email, Slack, databases. Each integration has different authentication flows, API endpoints, and capabilities. Without a registry, connector code is scattered across the codebase with no shared interface. Adding a new service means building it from scratch, and the orchestrator can't ask "who can handle a send operation for email?" without hardcoding which service handles what.

## Context

- An AI agent that interacts with external services on behalf of users
- Multiple services may fulfill the same role (e.g., different email providers)
- New integrations are added over time as the system gains capabilities
- Need for deterministic resolution: given an operation and parameters, the same connector should be selected every time (no LLM involved)
- Per-tenant configuration: different tenants may have different services configured

## Solution

### Base Class Contract

All connectors extend a `Connector` base class that defines the interface. The base class declares static properties for type, display name, priority, and capabilities, plus instance methods for each operation:

```javascript
// lib/connectors/base.js
class Connector {
  static type = 'base';
  static displayName = 'Base Connector';
  static priority = 0;
  static capabilities = {};

  constructor(config = {}, context = {}) {
    this.config = config;
    this.context = context;
    this.tenantId = context.tenantId;
  }

  // Operation methods — subclasses override these
  async read(query, options = {}) {
    throw new Error(`${this.type} connector does not implement read()`);
  }
  async write(data, options = {}) { throw new Error('...'); }
  async update(query, changes) { throw new Error('...'); }
  async delete(query) { throw new Error('...'); }
  async search(query, options = {}) { throw new Error('...'); }
  async list(filters = {}, pagination = {}) { throw new Error('...'); }
  async send(message, recipients) { throw new Error('...'); }

  // Capability checking
  canHandle(operation, params) {
    const cap = this.capabilities[operation];
    if (!cap) return false;
    const key = params.source || params.target || params.channel || params.scope;
    const validKeys = cap.sources || cap.targets || cap.channels || cap.scopes || [];
    return validKeys.includes(key);
  }

  // Health checking
  async checkHealth() {
    return { status: 'healthy', issues: [], details: {} };
  }
}
```

### Implementation Example: Email Connector

Each connector declares its capabilities as a map of operations to the sources/targets/channels it handles:

```javascript
// lib/connectors/implementations/email.js
class EmailConnector extends Connector {
  static type = 'email';
  static displayName = 'Email (Gmail)';
  static priority = 10;

  static capabilities = {
    read:   { sources: ['email', 'emails', 'mail', 'inbox', 'draft', 'drafts'] },
    write:  { targets: ['draft', 'drafts', 'email_draft'] },
    send:   { channels: ['email', 'mail'] },
    search: { scopes: ['email', 'emails', 'mail', 'inbox'] },
    list:   { sources: ['email', 'emails', 'inbox', 'draft', 'drafts', 'unread'] },
    update: { targets: ['email', 'draft'] },
    delete: { targets: ['draft', 'email'] },
  };

  // Lazy-load the underlying Gmail module
  get gmail() {
    if (!this._gmail) this._gmail = require('../../google/gmail');
    return this._gmail;
  }

  async read(query, options = {}) {
    const { id, source } = { ...query, ...options };
    if (source === 'draft') return this.gmail.getDraft(id, this._getGmailOptions());
    return this.gmail.getEmail(id, this._getGmailOptions());
  }

  async send(message, recipients) {
    const { subject, body, threadId } = message;
    const to = Array.isArray(recipients) ? recipients.join(', ') : recipients;
    if (threadId) return this.gmail.replyToEmail({ threadId, to, subject, body }, ...);
    return this.gmail.sendEmail({ to, subject, body }, ...);
  }

  async checkHealth() {
    const count = await this.gmail.getUnreadCount(this._getGmailOptions());
    return { status: 'healthy', issues: [], details: { unreadCount: count } };
  }
}

// Self-register on require
connectors.register(EmailConnector);
```

Three implementations exist: Email (Gmail), Slack, and Postgres.

### Registry with Auto-Loading

The registry (`lib/connectors/index.js`) maintains a type map and instance cache. Implementations are auto-loaded from the `implementations/` directory on startup:

```javascript
// lib/connectors/index.js
const connectorTypes = new Map();  // type -> ConnectorClass
const instanceCache = new Map();   // tenantId -> Map<type, instance>

function register(ConnectorClass) {
  connectorTypes.set(ConnectorClass.type, ConnectorClass);
}

function getInstance(type, context = {}, config = {}) {
  const { tenantId = 'default' } = context;

  if (!instanceCache.has(tenantId)) instanceCache.set(tenantId, new Map());
  const tenantCache = instanceCache.get(tenantId);

  // Return cached instance if no custom config
  if (tenantCache.has(type) && Object.keys(config).length === 0) {
    return tenantCache.get(type);
  }

  const ConnectorClass = connectorTypes.get(type);
  if (!ConnectorClass) return null;

  const instance = new ConnectorClass(config, context);
  tenantCache.set(type, instance);
  return instance;
}

// Auto-load all implementations on startup
function loadConnectors() {
  const files = fs.readdirSync(implementationsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    require(path.join(implementationsDir, file));
    // Each file self-registers via connectors.register(MyConnector)
  }
}

loadConnectors();
```

### Capability-Based Resolution

`findCapable()` returns all connector classes that can handle a given operation and parameter combination, sorted by priority:

```javascript
function findCapable(operation, params, context = {}) {
  const capable = [];

  for (const ConnectorClass of connectorTypes.values()) {
    const cap = ConnectorClass.capabilities[operation];
    if (!cap) continue;

    const key = params.source || params.target || params.channel || params.scope;
    const validKeys = cap.sources || cap.targets || cap.channels || cap.scopes || [];

    if (validKeys.includes(key)) {
      capable.push(ConnectorClass);
    }
  }

  // Higher priority preferred
  capable.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return capable;
}
```

### Priority-Based Resolver

The resolver (`lib/connectors/resolver.js`) selects the best connector through a 6-step cascade:

```javascript
// lib/connectors/resolver.js
async function resolve(operation, params, context = {}) {
  // 1. Explicit connector prefix (e.g., "slack:channel_123")
  const { connector: explicitType, key } = parseExplicitConnector(keyValue);
  if (explicitType) return { connector: getInstance(explicitType, context), params: { ...params, [keyField]: key } };

  // 2. Find all capable connectors
  const capableClasses = findCapable(operation, params, context);
  if (capableClasses.length === 0) throw new Error(`No connector found for ${operation}`);

  // 3. Active channel preference (user said "I'm on Slack")
  if (context.activeChannel) {
    const match = capableClasses.find(c => c.type === context.activeChannel);
    if (match) return { connector: getInstance(match.type, context), params };
  }

  // 4. Source channel (message came from this channel)
  if (context.sourceChannel) {
    const match = capableClasses.find(c => c.type === context.sourceChannel);
    if (match) return { connector: getInstance(match.type, context), params };
  }

  // 5. User preferences per operation category
  if (context.userPreferences) {
    const category = getOperationCategory(operation); // 'message', 'storage', 'search'
    const preferred = capableClasses.find(c => c.type === context.userPreferences[category]);
    if (preferred) return { connector: getInstance(preferred.type, context), params };
  }

  // 6. Highest priority connector (already sorted)
  return { connector: getInstance(capableClasses[0].type, context), params };
}
```

### Explicit Connector Syntax

Users can force a specific connector by prefixing the target with the connector type:

```javascript
function parseExplicitConnector(value) {
  const match = value.match(/^([a-z_]+):(.+)$/i);
  if (match && !['http', 'https', 'ftp', 'file'].includes(match[1].toLowerCase())) {
    return { connector: match[1].toLowerCase(), key: match[2] };
  }
  return { connector: null, key: value };
}

// "slack:general" → connector: 'slack', key: 'general'
// "https://example.com" → connector: null, key: 'https://example.com' (URL, not prefix)
```

### Context Manager

A `ConnectorContext` singleton tracks the active channel, source channel, and user preferences per tenant:

```javascript
class ConnectorContext {
  constructor() {
    this.contexts = new Map(); // tenantId -> { activeChannel, sourceChannel, preferences }
  }

  setActiveChannel(tenantId, channel) { ... }
  setSourceChannel(tenantId, channel) { ... }
  setPreference(tenantId, category, connectorType) { ... }

  inferFromSource(tenantId, source) {
    const { connector } = parseExplicitConnector(source);
    if (connector) this.setSourceChannel(tenantId, connector);
  }
}
```

## Implications

- Self-registration via `require` side effects means adding a new connector is a single file drop into `implementations/` -- no registry configuration needed
- Instance caching means connector objects are reused per tenant, which is good for connection pooling but means stale config requires a cache clear
- Priority-based resolution is deterministic: the same inputs always select the same connector. No LLM involvement in routing
- The 6-step resolution cascade provides multiple override points: explicit prefix beats active channel beats source channel beats preferences beats priority
- Capability declarations use string arrays, not capability objects, so there's no metadata about capability quality or limitations per connector
- URL-like values ("https://...") are correctly excluded from the explicit connector prefix parser, preventing false positive matches
- Health checking is per-connector: each implementation can check its own service's availability, enabling a system-wide health dashboard
- The base class throws descriptive errors for unimplemented operations, making it clear when a connector is being asked to do something it doesn't support

## Code Example

```javascript
// Operation: send an email
const { connector, params } = await resolve('send', { channel: 'email' }, {
  tenantId: 'tenant-1',
});
// Resolves to EmailConnector (priority 10, supports send with channel 'email')

await connector.send(
  { subject: 'Invoice', body: 'Please find attached...' },
  'client@example.com'
);

// Operation: read from an explicitly specified connector
const { connector: slackConn } = await resolve('read', { source: 'slack:general' }, {
  tenantId: 'tenant-1',
});
// Resolves to SlackConnector with key 'general' (explicit prefix)

// List all registered connector types
const types = connectors.getTypes();
// ['email', 'slack', 'postgres']

// Find all connectors that can search emails
const capable = connectors.findCapable('search', { scope: 'email' });
// [EmailConnector] (sorted by priority)
```

## Related Patterns

- [Capability Manifest Registration](./capability-manifest-registration.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Plugin System and Hot-Reload](./plugin-system-and-hot-reload.md)
