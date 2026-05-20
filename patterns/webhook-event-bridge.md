# Webhook Event Bridge

> Bidirectional webhook plumbing: an inbound HTTP server with HMAC verification routes external events to the internal bus, and an outbound dispatcher with retries and signing fans internal events out to registered subscribers.

## Problem

Internal events need to reach external consumers (dashboards, accounting, notifications), and external services (GitHub, Claude Code, monitoring tools) need to push events back in. Without a unified bridge each integration grows its own HTTP code, its own retry strategy, its own signature verification, and its own payload normalization — and the inbound and outbound sides drift apart until they have nothing in common.

## Context

- An internal event bus already exists and is the canonical source of truth for what happened
- External producers (GitHub, Claude Code agents, ops tooling) need a single inbound surface to push events into the bus
- External consumers need at-least-once delivery, with retries and signing, without each subscriber re-implementing it
- HMAC-SHA256 verification is the minimum security bar for inbound webhooks
- Outbound subscribers come and go at runtime — registration must be dynamic, not config-file

## Solution

The bridge is split across two co-located but distinct surfaces:

- **Inbound** — a standalone HTTP server (`lib/webhook-server.js`) on a dedicated port that authenticates, parses, and forwards external events to the internal bus
- **Outbound** — a dispatcher (`lib/webhooks/outbound.js` + `lib/webhooks/event-bridge.js`) that subscribes to the internal bus and forwards matching events to registered URLs

A facade (`lib/webhooks/index.js`) re-exports the outbound + bridge halves so internal callers don't reach into submodules.

### Inbound: Dedicated HTTP Server with Per-Source Routes

A separate process listens on `RILEY_WEBHOOK_PORT` (default 7432). Each source has its own route — currently `/github` (full GitHub event suite) and `/notify` (Claude Code task updates) — plus `/health` for liveness:

```javascript
// lib/webhook-server.js
const PORT = process.env.RILEY_WEBHOOK_PORT || 7432
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET

function verifyGitHubSignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true   // verification opt-in
  if (!signature) return false
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET)
  const digest = 'sha256=' + hmac.update(payload).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))
}

server = http.createServer(async (req, res) => {
  const url = req.url
  const body = await readBody(req)

  if (url === '/github') {
    if (!verifyGitHubSignature(body, req.headers['x-hub-signature-256'])) {
      res.writeHead(401); res.end('invalid signature'); return
    }
    const event = req.headers['x-github-event']
    const payload = JSON.parse(body)
    events.emit(`github.${event}`, payload)   // → internal bus
  }
  // ... /notify, /health
})
```

Signature verification is GitHub-only today; adding Stripe or Slack means another route plus another verifier (Stripe asymmetric, Slack signing secret). The single-source-per-route shape keeps that addition mechanical.

### Outbound: Bus Subscription with Enumerated Event Types

The event-bridge subscribes to the internal bus and forwards a curated set of event types to outbound subscribers. The enumeration is deliberate — not every internal event should leak to external systems:

```javascript
// lib/webhooks/event-bridge.js
const EVENT_TYPES = [
  'task.created', 'task.updated', 'task.completed',
  'goal.created', 'goal.completed',
  'project.created', 'client.created',
  'entity.created', 'entity.updated', 'entity.deleted',
  'job.failed', 'system.notification',
]

for (const eventType of EVENT_TYPES) {
  internalBus.on(eventType, (payload) => {
    outbound.trigger(eventType, payload)
  })
}
```

### Outbound: Dynamic Registration with HMAC Signing and Retry

Subscribers register at runtime against one or more event types. Each delivery is HMAC-signed so the consumer can verify origin; failures retry with exponential backoff capped at 30s:

```javascript
// lib/webhooks/outbound.js
function register(eventType, { id, url, secret, maxRetries = 3, enabled = true }) {
  subscriptions.get(eventType) ?? subscriptions.set(eventType, [])
  subscriptions.get(eventType).push({ id, url, secret, maxRetries, enabled })
}

async function trigger(eventType, payload) {
  for (const target of subscriptions.get(eventType) ?? []) {
    if (!target.enabled) continue
    await deliverWithRetry(target, eventType, payload)
  }
}

async function deliverWithRetry(target, eventType, payload, attempt = 0) {
  const body = JSON.stringify({ type: eventType, data: payload, ts: Date.now() })
  const signature = crypto.createHmac('sha256', target.secret).update(body).digest('hex')

  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': eventType,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok && attempt < target.maxRetries) {
      setTimeout(() => deliverWithRetry(target, eventType, payload, attempt + 1),
                 Math.min(1000 * 2 ** attempt, 30_000))
    }
  } catch (err) {
    if (attempt < target.maxRetries) {
      setTimeout(() => deliverWithRetry(target, eventType, payload, attempt + 1),
                 Math.min(1000 * 2 ** attempt, 30_000))
    }
  }
}
```

`enable`/`disable` toggles let an operator silence a noisy subscriber without unregistering, and `test` issues a synthetic delivery to validate URL + secret before the first real event.

### Why Inbound and Outbound Are Separate Processes

The inbound server has different uptime requirements than the main app — GitHub will retry failed deliveries on its own schedule, so the receiver should stay up across main-app restarts. Running it as a separate process (`node lib/webhook-server.js`) means the main app can restart for code changes without losing GitHub-side retry alignment.

## Implications

- **Two surfaces, one shared facade** — `lib/webhooks/index.js` only exposes the outbound + bridge halves; the inbound server is invoked directly because it's a separate process, not an in-process callable
- **Enumerated outbound event types** — adding a new external-visible event requires editing `EVENT_TYPES`, which is the right friction point: it forces a conscious decision about what should leak outside
- **At-least-once outbound delivery** — subscribers must be idempotent or dedupe on the event id; the 30s retry cap prevents pile-up on a slow consumer
- **GitHub-only inbound verification today** — Stripe/Slack inbound are not in place; each new source needs a route plus a verifier. The pattern is "one route per source" rather than a generic `/webhooks/:source` registry
- **Signature verification opt-in for GitHub** — if `GITHUB_WEBHOOK_SECRET` is unset, verification is skipped (useful for local dev, dangerous if forgotten in prod)
- **Outbound subscriptions live in memory** — registrations need to be re-applied on restart unless persisted by the caller

## Code Example

```javascript
// Outbound: subscribe an external consumer to payment events
const { outbound } = require('./lib/webhooks')

outbound.register('task.completed', {
  id: 'analytics-pipeline',
  url: 'https://analytics.internal/webhooks/tasks',
  secret: process.env.ANALYTICS_WEBHOOK_SECRET,
  maxRetries: 5,
})

// Anywhere in the app — completion event flows to internal bus,
// the bridge forwards to all 'task.completed' subscribers,
// analytics receives an HMAC-signed POST with retry on 5xx
await entities.complete('task', taskId)
```

```bash
# Inbound: start the dedicated webhook server (separate process)
GITHUB_WEBHOOK_SECRET=... RILEY_WEBHOOK_PORT=7432 node lib/webhook-server.js
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Unified Trigger System](./unified-trigger-system.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
