# Webhook Event Bridge

> Outbound webhook dispatch with delivery tracking and retry. Inbound webhook receiving is not yet implemented.

## Problem

Internal events need to reach external consumers — monitoring dashboards, accounting services, notification systems. Without a unified outbound dispatch system, each integration needs its own HTTP delivery logic, its own retry strategy, and its own payload formatting. This leads to duplicated infrastructure code across integrations.

## Context

- Internal systems produce events that external consumers need to react to
- External consumers need at-least-once delivery guarantees
- Different consumers have different reliability characteristics and retry needs
- The system may need to support many outbound targets over time without proportional growth in dispatch infrastructure
- **Inbound webhook receiving** (accepting webhooks from GitHub, Stripe, Slack, etc.) is a planned capability but **not yet implemented** — there is no `/webhooks/:source` route or signature verification registry

## Solution

### Outbound Webhook Dispatch

The outbound side listens for internal events and dispatches them to registered external consumers. Delivery tracking and retry logic provide at-least-once semantics:

```javascript
const subscriptions = new Map(); // eventType -> [{ url, secret, retries }]
const deliveryLog = [];

function registerOutbound(eventType, config) {
  if (!subscriptions.has(eventType)) {
    subscriptions.set(eventType, []);
  }
  subscriptions.get(eventType).push({
    url: config.url,
    secret: config.secret,
    maxRetries: config.maxRetries || 3,
    id: config.id
  });
}

async function dispatchOutbound(eventType, payload) {
  const targets = subscriptions.get(eventType) || [];

  for (const target of targets) {
    await deliverWithRetry(target, eventType, payload);
  }
}
```

### Delivery with Retry and Signing

Each outbound delivery is signed with HMAC-SHA256 and retried with exponential backoff on failure:

```javascript
async function deliverWithRetry(target, eventType, payload, attempt = 0) {
  const body = JSON.stringify({ type: eventType, data: payload, timestamp: Date.now() });
  const signature = crypto
    .createHmac('sha256', target.secret)
    .update(body)
    .digest('hex');

  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': eventType
      },
      body,
      signal: AbortSignal.timeout(10000)
    });

    deliveryLog.push({
      target: target.id, eventType, status: response.status,
      attempt, deliveredAt: Date.now()
    });

    if (!response.ok && attempt < target.maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      setTimeout(() => deliverWithRetry(target, eventType, payload, attempt + 1), delay);
    }
  } catch (err) {
    deliveryLog.push({
      target: target.id, eventType, status: 'error',
      error: err.message, attempt, failedAt: Date.now()
    });

    if (attempt < target.maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      setTimeout(() => deliverWithRetry(target, eventType, payload, attempt + 1), delay);
    }
  }
}
```

### Event System Integration

Outbound dispatch is wired to the internal event system:

```javascript
// Wire outbound dispatch to event system
events.on('*', (eventType, payload) => {
  dispatchOutbound(eventType, payload);
});
```

### Inbound Webhooks (Not Yet Implemented)

Inbound webhook receiving — a single `/webhooks/:source` endpoint with per-source signature verification, payload normalization, and event bridging — is designed but not yet implemented. The planned architecture includes:

- Single receiver endpoint with source-based routing
- Per-source signature verification registry (HMAC-SHA256, Stripe asymmetric, Slack signing secrets)
- Payload normalization from source-specific formats to internal events
- Source-specific handler registration for business logic

This section will be updated when inbound webhook support is built.

## Implications

- **Outbound only** — the system can push events to external consumers but cannot yet receive webhooks from external services
- At-least-once outbound delivery — retry logic means external consumers may receive duplicate events. Consumers must be idempotent or use the event ID for deduplication
- Delivery log growth — the in-memory delivery log grows unbounded without pruning. Production use requires periodic cleanup or persistence to a store
- Exponential backoff with a 30-second cap prevents hammering failing endpoints while keeping retry windows reasonable
- The HMAC signature on outbound payloads gives consumers signature validation guarantees

## Code Example

```javascript
// Full wiring — outbound only
const { registerOutbound } = require('./lib/webhooks/outbound');
const { events } = require('./lib/events');

// Register outbound webhook for payment events
registerOutbound('payment.completed', {
  id: 'accounting-service',
  url: 'https://accounting.internal/webhooks/payments',
  secret: process.env.ACCOUNTING_WEBHOOK_SECRET,
  maxRetries: 5
});

// The flow: internal event fires → outbound dispatcher sends
// to accounting service with retry and HMAC signing
events.emit('payment.completed', {
  amount: 5000,
  customer: 'cust_123',
  source: 'internal'
});
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Unified Trigger System](./unified-trigger-system.md)
