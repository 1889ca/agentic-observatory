# Audit Trail with PII Sanitization

> Correlation-ID traced audit logging with batched non-blocking persistence and PII scrubbing before any data reaches the database.

## Problem

Without structured audit logging, reconstructing what happened during a multi-step orchestration is guesswork. Naively logging everything creates a different problem: sensitive user data accumulates in audit tables over time, creating compliance risk. Per-event synchronous writes compound this by adding latency to every operation in the main path.

## Context

This pattern applies to any orchestration system that needs a tamper-evident record of actions across async chains — especially when those actions involve user-provided input that may contain emails, phone numbers, or other PII. It is the foundation for debugging, compliance reporting, and post-incident analysis.

## Solution

Every action is tagged with a correlation ID at the entry point (HTTP request, webhook, socket event) and that ID is propagated through the entire async chain via a request-scoped context object. Before any audit entry is written, a scrubbing pass detects and redacts sensitive fields using key-based redaction. Writes are batched and flushed on an interval rather than on each event, so audit logging is never in the critical path.

The flow:

1. Entry point generates or receives a correlation ID and attaches it to the async context.
2. Every `audit.log(action, payload)` call pulls the current correlation ID from context automatically.
3. The payload passes through the PII scrubber before being enqueued.
4. A background flush loop drains the queue in batches to the database.

```js
// lib/audit/index.js

const { getContext } = require('../context');
const { scrubPII } = require('./scrubber');
const { flushBatch } = require('./persistence');

const queue = [];
const FLUSH_INTERVAL_MS = 2000;
const BATCH_SIZE = 50;

function log(action, payload = {}) {
  const { correlationId, tenantId, userId } = getContext();
  const entry = {
    correlationId,
    tenantId,
    userId,
    action,
    payload: scrubPII(payload),
    ts: Date.now(),
  };
  queue.push(entry);
}

setInterval(() => {
  if (queue.length === 0) return;
  const batch = queue.splice(0, BATCH_SIZE);
  flushBatch(batch).catch(err => {
    // Re-queue on transient failure; drop on persistent failure to avoid memory leak
    if (err.transient) queue.unshift(...batch);
  });
}, FLUSH_INTERVAL_MS);

module.exports = { log };
```

```js
// lib/audit/scrubber.js

const SENSITIVE_KEYS = new Set([
  'password', 'secret', 'token', 'apiKey', 'api_key',
  'authorization', 'credential', 'credentials',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'privateKey', 'private_key',
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(key) ||
    SENSITIVE_KEYS.has(key.toLowerCase());
}

function scrubPII(obj) {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(scrubPII);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) =>
        [k, isSensitiveKey(k) ? '[REDACTED]' : scrubPII(v)]
      )
    );
  }
  return obj;
}

module.exports = { scrubPII };
```

> **Note:** Regex-based PII scrubbing (matching emails, phone numbers, SSNs within string values) is a natural extension of this pattern but is not currently implemented. The actual scrubber uses key-based redaction — checking whether object keys match a sensitive-key list and replacing their values wholesale. This is simpler and avoids regex false-positive issues, but does not catch PII embedded in free-text string values.

Retention is configured per-action-type. A background job enforces TTLs, deleting entries older than the configured window for each action class.

## Implications

- Audit entries are eventually consistent — the flush interval means a crash within the window can lose the last batch. This is acceptable for most orchestration use cases; use synchronous writes only for legally mandated events.
- Key-based redaction catches structured sensitive fields (passwords, tokens, API keys) but does not scrub PII embedded in free-text string values. If free-text fields may contain emails, phone numbers, or SSNs, an additional regex-based scrubbing layer should be added.
- Key-based redaction has no false-positive risk on values but depends on maintaining a complete sensitive-key list. New sensitive field names must be added to the list as the schema evolves.
- Batching decouples audit throughput from DB throughput, enabling high-frequency orchestration without DB saturation.
- The correlation ID enables full trace reconstruction across services, which is the primary value of this pattern for debugging.

## Code Example

```js
const audit = require('../lib/audit');

async function handleWebhook(req, res) {
  // correlationId is already in context from middleware
  audit.log('webhook.received', { source: req.body.source, event: req.body.event });

  await processEvent(req.body);

  audit.log('webhook.processed', { outcome: 'success' });
  res.sendStatus(200);
}
```

## Related Patterns

- [Request-Scoped Context Propagation](./request-scoped-context.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
