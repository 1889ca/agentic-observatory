# Channel Adapter Architecture

> Pluggable adapter contract for multi-channel messaging. Each adapter implements init/disconnect/sendMessage/getStatus. Registry validates contracts, router dispatches.

## Problem

An orchestrator needs to communicate across multiple channels — Slack, Telegram, email, WhatsApp — but each has a different API, authentication scheme, and message format. Without a clean abstraction, channel-specific code spreads across the codebase: formatting logic leaks into the message processor, auth handling gets duplicated, and adding a new channel means modifying dozens of files. The coupling between "what to send" and "how to send it" makes the system fragile and hard to extend.

## Context

- An AI agent sends and receives messages across 4+ platforms simultaneously
- Each platform has its own SDK, auth flow, rate limits, and message format (Slack blocks vs. Telegram Markdown vs. HTML email vs. WhatsApp templates)
- Channels may go offline independently — Slack can be down while Telegram is fine
- New channels need to be addable without touching existing code
- The orchestrator needs a uniform way to check channel health and dispatch messages

## Solution

### Adapter Contract

Every channel adapter implements a standard four-method interface. A base class defines the contract and provides shared utilities:

```javascript
// lib/channels/adapter.js
class ChannelAdapter {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.status = 'disconnected';
  }

  async init() {
    throw new Error(`${this.name} must implement init()`);
  }

  async disconnect() {
    throw new Error(`${this.name} must implement disconnect()`);
  }

  async sendMessage(recipient, content, options = {}) {
    throw new Error(`${this.name} must implement sendMessage()`);
  }

  getStatus() {
    return { channel: this.name, status: this.status };
  }
}
```

The contract is intentionally small. Four methods are enough to cover the lifecycle (init/disconnect) and the core operations (send/status). Channel-specific features like reactions, threads, or read receipts live in the adapter subclass, not the contract.

### Channel Registry

The registry validates that every adapter implements the full contract before allowing registration. This catches incomplete adapters at startup rather than at runtime when a message fails to send:

```javascript
// lib/channels/registry.js
const REQUIRED_METHODS = ['init', 'disconnect', 'sendMessage', 'getStatus'];

class ChannelRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(adapter) {
    for (const method of REQUIRED_METHODS) {
      if (typeof adapter[method] !== 'function') {
        throw new Error(
          `Adapter "${adapter.name}" missing required method: ${method}`
        );
      }
    }

    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" already registered`);
    }

    this.adapters.set(adapter.name, adapter);
  }

  get(channelName) {
    return this.adapters.get(channelName);
  }

  async initAll() {
    const results = [];
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.init();
        results.push({ channel: name, status: 'connected' });
      } catch (err) {
        results.push({ channel: name, status: 'failed', error: err.message });
      }
    }
    return results;
  }
}
```

Instance caching is built in — one adapter instance per channel type, stored in the Map. The registry is the single source of truth for which channels are available.

### Message Router

The router sits between the orchestrator and the adapters. It resolves the target channel, handles format conversion, and dispatches:

```javascript
// lib/channels/router.js
class MessageRouter {
  constructor(registry) {
    this.registry = registry;
  }

  async route(channel, recipient, content, options = {}) {
    const adapter = this.registry.get(channel);
    if (!adapter) {
      throw new Error(`No adapter registered for channel: ${channel}`);
    }

    const formatted = this.formatForChannel(channel, content);
    return adapter.sendMessage(recipient, formatted, options);
  }

  formatForChannel(channel, content) {
    const formatters = {
      slack: (c) => this.toSlackBlocks(c),
      telegram: (c) => this.toTelegramMarkdown(c),
      email: (c) => this.toHtml(c),
      whatsapp: (c) => this.toPlainText(c),
    };
    return (formatters[channel] || ((c) => c))(content);
  }
}
```

The router is the single dispatch point. No other part of the system needs to know which adapter handles which channel or how messages are formatted for each platform.

### Channel-Specific Adapters

Each channel extends the base adapter with platform-specific logic:

```javascript
// lib/channels/telegram/adapter.js
class TelegramAdapter extends ChannelAdapter {
  constructor(config) {
    super('telegram', config);
    this.bot = null;
  }

  async init() {
    this.bot = new TelegramBot(this.config.token);
    await this.bot.setWebhook(this.config.webhookUrl);
    this.status = 'connected';
  }

  async disconnect() {
    await this.bot.deleteWebhook();
    this.status = 'disconnected';
  }

  async sendMessage(chatId, content, options = {}) {
    return this.bot.sendMessage(chatId, content, {
      parse_mode: 'Markdown',
      ...options,
    });
  }
}
```

Each adapter owns its SDK, auth, and message formatting. The Slack adapter deals with Bolt and blocks. The email adapter deals with SMTP and HTML. None of that leaks outside the adapter directory.

## Implications

- Adding a new channel means implementing one adapter file with four methods — no changes to the router, registry, or orchestrator
- Registry validation catches incomplete adapters at startup, producing a clear error before any messages are attempted
- The router is the single dispatch point, making it easy to add cross-cutting concerns like logging, rate limiting, or delivery tracking
- Format conversion in the router means the orchestrator always works with a single content format — adapters never need to understand each other's formats
- Channel failures are isolated — a Telegram outage doesn't affect Slack delivery
- The base adapter's `getStatus()` provides a uniform health check surface for monitoring

## Code Example

```javascript
// Wiring it all together at startup
const registry = new ChannelRegistry();

registry.register(new SlackAdapter(config.slack));
registry.register(new TelegramAdapter(config.telegram));
registry.register(new EmailAdapter(config.email));
registry.register(new WhatsAppAdapter(config.whatsapp));

const results = await registry.initAll();
// [{ channel: 'slack', status: 'connected' }, ...]

const router = new MessageRouter(registry);

// Dispatching a message — caller doesn't care about channel internals
await router.route('telegram', chatId, 'Deployment complete.');
await router.route('slack', '#ops', 'Deployment complete.');
```

## Related Patterns

- [Message Processing Pipeline](./message-processing-pipeline.md)
- [Unified Event System](./unified-event-system.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
