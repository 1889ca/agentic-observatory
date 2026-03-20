# Audit Trail with PII Sanitization

> Correlation-ID traced audit logging with batched non-blocking persistence and PII scrubbing before any data reaches the database.

## Problem

Without structured audit logging, reconstructing what happened during a multi-step orchestration is guesswork. Naively logging everything creates a different problem: sensitive user data accumulates in audit tables over time, creating compliance risk. Per-event synchronous writes compound this by adding latency to every operation in the main path.

## Context

This pattern applies to any orchestration system that needs a tamper-evident record of actions across async chains — especially when those actions involve user-provided input that may contain emails, phone numbers, or other PII. It is the foundation for debugging, compliance reporting, and post-incident analysis.

## Solution

Every action is tagged with a correlation ID at the entry point (HTTP request, webhook, socket event) and that ID is propagated through the entire async chain via a request-scoped context object. Before any audit entry is written, a scrubbing pass detects and neutralizes PII using a set of configurable regex patterns. Writes are batched and flushed on an interval rather than on each event, so audit logging is never in the critical path.

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

const RULES = [
  { name: 'email',  pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replace: '[EMAIL]' },
  { name: 'phone',  pattern: /(\+?1?\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,  replace: '[PHONE]' },
  { name: 'ssn',    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,                            replace: '[SSN]'   },
];

function scrubValue(value) {
  if (typeof value !== 'string') return value;
  return RULES.reduce((v, rule) => v.replace(rule.pattern, rule.replace), value);
}

function scrubPII(obj) {
  if (typeof obj === 'string') return scrubValue(obj);
  if (Array.isArray(obj)) return obj.map(scrubPII);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, scrubPII(v)])
    );
  }
  return obj;
}

module.exports = { scrubPII };
```

Retention is configured per-action-type. A background job enforces TTLs, deleting entries older than the configured window for each action class.

## Implications

- Audit entries are eventually consistent — the flush interval means a crash within the window can lose the last batch. This is acceptable for most orchestration use cases; use synchronous writes only for legally mandated events.
- PII scrubbing is applied to values, not keys. If a key name itself is sensitive (e.g., a field named `ssn`), the scrubber must also be extended to handle key patterns.
- Regex-based scrubbing has false positives and false negatives. It is a risk-reduction layer, not a guarantee. Do not log raw user input for high-sensitivity domains.
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
