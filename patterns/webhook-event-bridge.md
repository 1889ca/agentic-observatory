# Webhook Event Bridge

> Unified inbound webhook receiver with source-based routing, payload normalization, event system bridging, and outbound webhook dispatch with delivery tracking.

## Problem

External services — GitHub, Stripe, Slack, monitoring tools — send webhooks with different payload formats, authentication schemes, and retry semantics. Without a unified receiver, each integration needs its own HTTP endpoint, its own signature validation logic, and its own event translation layer. This leads to duplicated infrastructure code across integrations: three different HMAC verification implementations, three different payload parsing strategies, three different ways of feeding data into the internal event system. Adding a new webhook source means standing up a new route, writing new validation code, and wiring up yet another ad-hoc bridge to the event bus. Outbound webhook dispatch — notifying external consumers when internal events occur — compounds the problem with its own set of retry logic, delivery tracking, and payload formatting concerns.

## Context

- Multiple external services push webhooks with incompatible payload structures and authentication methods (GitHub uses HMAC-SHA256, Stripe uses asymmetric signatures, Slack uses signing secrets with timestamps)
- Internal systems need to react to external events through the unified event system rather than handling them in isolated HTTP handlers
- External consumers need to be notified of internal events via outbound webhooks, with at-least-once delivery guarantees
- Webhook sources have different retry behaviors — GitHub retries on 5xx, Stripe retries with exponential backoff, some sources don't retry at all
- The system may need to support dozens of webhook sources over time without proportional growth in routing infrastructure

## Solution

### Single Receiver Endpoint

All inbound webhooks route through a single HTTP endpoint. The source is identified by a path segment or header, and the receiver delegates to source-specific handlers:

```javascript
// lib/webhook-server.js
const express = require('express');
const { verifySignature, routeWebhook } = require('./webhooks');

const app = express();

// Raw body needed for signature verification — must come before JSON parsing
app.post('/webhooks/:source', express.raw({ type: '*/*' }), async (req, res) => {
  const { source } = req.params;

  // Verify signature before any processing
  const valid = await verifySignature(source, req.headers, req.body);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse and route
  const payload = JSON.parse(req.body.toString());
  const result = await routeWebhook(source, req.headers, payload);

  res.status(200).json({ received: true, eventId: result.eventId });
});
```

The raw body capture is critical — signature verification must run against the exact bytes received, not a re-serialized JSON object. Parsing happens only after the signature is validated.

### Signature Verification Registry

Each webhook source registers its own verification strategy. The registry maps source names to verifier functions:

```javascript
// lib/webhooks/index.js
const crypto = require('crypto');

const verifiers = new Map();

verifiers.set('github', (headers, body) => {
  const signature = headers['x-hub-signature-256'];
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
});

verifiers.set('stripe', (headers, body) => {
  const signature = headers['stripe-signature'];
  if (!signature) return false;
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  try {
    stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    return true;
  } catch {
    return false;
  }
});

verifiers.set('slack', (headers, body) => {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  // Reject requests older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const baseString = `v0:${timestamp}:${body.toString()}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(slackSig), Buffer.from(expected));
});

async function verifySignature(source, headers, body) {
  const verifier = verifiers.get(source);
  if (!verifier) return false; // Unknown sources are rejected
  return verifier(headers, body);
}
```

Using `crypto.timingSafeEqual` for all comparisons prevents timing-based signature attacks. Unknown sources are rejected outright — there's no permissive fallback.

### Payload Normalization and Event Bridging

The event bridge translates source-specific payloads into normalized internal events and emits them through the unified event system:

```javascript
// lib/webhooks/event-bridge.js
const { events } = require('../events');

const normalizers = new Map();

normalizers.set('github', (headers, payload) => {
  const githubEvent = headers['x-github-event'];
  return {
    source: 'github',
    type: `webhook.github.${githubEvent}`,
    action: payload.action || githubEvent,
    actor: payload.sender?.login,
    repo: payload.repository?.full_name,
    data: payload,
    receivedAt: Date.now()
  };
});

normalizers.set('stripe', (headers, payload) => {
  return {
    source: 'stripe',
    type: `webhook.stripe.${payload.type}`,
    action: payload.type,
    actor: null,
    data: payload.data?.object,
    stripeEventId: payload.id,
    receivedAt: Date.now()
  };
});

async function routeWebhook(source, headers, payload) {
  const normalizer = normalizers.get(source);
  if (!normalizer) {
    throw new Error(`No normalizer registered for source: ${source}`);
  }

  const event = normalizer(headers, payload);
  const eventId = `wh_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  event.eventId = eventId;

  // Bridge to unified event system
  events.emit(event.type, event);
  events.emit('webhook.received', event); // Catch-all for audit/logging

  // Source-specific handler if registered
  const handler = handlers.get(source);
  if (handler) {
    await handler(event);
  }

  return { eventId };
}
```

Every inbound webhook produces two event emissions: a typed event (`webhook.github.push`) for specific listeners, and a generic `webhook.received` event for cross-cutting concerns like audit logging and delivery metrics. The raw payload is preserved in the `data` field so downstream handlers can access source-specific details when the normalized fields aren't sufficient.

### Handler Registry

Source-specific handlers run after normalization and event emission. They handle business logic that's tightly coupled to a particular source:

```javascript
// lib/webhooks/event-bridge.js (continued)
const handlers = new Map();

function registerHandler(source, handler) {
  handlers.set(source, handler);
}

// Example: GitHub push handler triggers a deployment check
registerHandler('github', async (event) => {
  if (event.action === 'push' && event.data.ref === 'refs/heads/main') {
    events.emit('deployment.check', {
      repo: event.repo,
      sha: event.data.after,
      triggeredBy: event.actor
    });
  }
});
```

### Outbound Webhook Dispatch

The outbound side listens for internal events and dispatches them to registered external consumers. Delivery tracking and retry logic provide at-least-once semantics:

```javascript
// lib/webhooks/outbound.js
const { events } = require('../events');

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

// Wire outbound dispatch to event system
events.on('*', (eventType, payload) => {
  dispatchOutbound(eventType, payload);
});
```

Outbound delivery uses exponential backoff with a 30-second cap. The delivery log provides an audit trail for debugging failed deliveries. The HMAC signature on outbound payloads mirrors the inbound verification pattern, giving consumers the same signature validation guarantees.

## Implications

- **Single endpoint bottleneck** — All webhook traffic funnels through one route. Under high volume, this receiver becomes a chokepoint. Horizontal scaling requires sticky routing or shared-nothing verification.
- **Signature verification latency** — Every inbound request pays the cost of cryptographic verification before any processing begins. For high-throughput sources, this adds measurable latency.
- **Normalization loses detail** — Flattening source-specific payloads into a common format necessarily discards structural nuances. The raw `data` field mitigates this, but downstream consumers that need source-specific fields must reach into it, partially defeating the abstraction.
- **At-least-once outbound delivery** — Retry logic means external consumers may receive duplicate events. Consumers must be idempotent or use the event ID for deduplication.
- **Delivery log growth** — The in-memory delivery log grows unbounded without pruning. Production use requires periodic cleanup or persistence to a store.
- **Unknown sources are silently rejected** — A 401 for an unregistered source is indistinguishable from a bad signature, making debugging new integrations harder without explicit logging.

## Code Example

```javascript
// Full wiring — inbound and outbound
const { verifySignature, routeWebhook, registerHandler } = require('./lib/webhooks');
const { registerOutbound } = require('./lib/webhooks/outbound');
const { events } = require('./lib/events');

// Register inbound handler for Stripe payment events
registerHandler('stripe', async (event) => {
  if (event.type === 'webhook.stripe.payment_intent.succeeded') {
    events.emit('payment.completed', {
      amount: event.data.amount,
      customer: event.data.customer,
      source: 'stripe'
    });
  }
});

// Register outbound webhook for payment events
registerOutbound('payment.completed', {
  id: 'accounting-service',
  url: 'https://accounting.internal/webhooks/payments',
  secret: process.env.ACCOUNTING_WEBHOOK_SECRET,
  maxRetries: 5
});

// The flow: Stripe sends webhook → receiver validates signature →
// normalizer creates internal event → handler emits payment.completed →
// outbound dispatcher sends to accounting service with retry
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Unified Trigger System](./unified-trigger-system.md)
