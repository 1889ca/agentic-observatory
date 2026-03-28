# Audit Trail with PII Sanitization

> Correlation-ID traced audit logging with 5-second batched non-blocking persistence to S3-compatible storage, and PII scrubbing using `.includes()` substring matching against a sensitive key list with long string truncation.

## Problem

Without structured audit logging, reconstructing what happened during a multi-step orchestration is guesswork. Naively logging everything creates a different problem: sensitive user data accumulates in audit stores over time, creating compliance risk. Per-event synchronous writes compound this by adding latency to every operation in the main path.

## Context

This pattern applies to any orchestration system that needs a tamper-evident record of actions across async chains — especially when those actions involve user-provided input that may contain tokens, passwords, or API keys. It is the foundation for debugging, compliance reporting, and post-incident analysis.

## Solution

### Architecture

The audit system is split across multiple files with clear responsibilities:

- `config.js` — timing, thresholds, and sensitive key lists
- `state.js` — S3 client initialization and shared buffer
- `core.js` — the main `log()` function and correlation ID generation
- `sanitize.js` — PII scrubbing and value truncation
- `storage.js` — batch flush to S3-compatible storage
- `tracking.js` — tool, job, and request execution wrappers
- `alerts.js` — error rate monitoring
- `maintenance.js` — log cleanup and error pattern analysis

### Correlation ID Propagation

Every audit entry pulls its correlation ID from three sources in priority order: explicit option, data payload, or the request-scoped `AsyncLocalStorage` context:

```javascript
// lib/audit/core.js
function log(operation, data = {}, options = {}) {
  if (!state.isEnabled()) return null;

  const corrId =
    options.correlationId ||
    data.correlationId ||
    requestContext.getCorrelationId();

  const entry = {
    id: `aud_${ulid()}`,
    ts: new Date().toISOString(),
    op: operation,
    comp: options.component || inferComponent(operation),
    status: options.status || 'ok',
    corrId,
    sessId: options.sessionId || requestContext.getUserId() || 'web_user',
    durMs: options.durationMs,
    err: options.error,
    data: sanitize(data),
  };

  buffer.push(entry);

  // Flush if buffer is full or on error
  if (buffer.length >= MAX_BUFFER_SIZE || options.status === 'error') {
    flushFn();
  }
}
```

The component is inferred from the operation string by splitting on `:` — `tool:execute` infers component `tool`.

### PII Scrubbing with Substring Matching

The scrubber uses `.includes()` substring matching against a sensitive key list — not exact `Set.has()` matching. This means `apiKey`, `myApiKey`, and `api_key_backup` all get redacted because they contain a sensitive substring:

```javascript
// lib/audit/sanitize.js
const SENSITIVE_KEYS = [
  'password', 'token', 'secret', 'apiKey', 'api_key',
  'accessToken', 'refreshToken', 'authorization',
  'cookie', 'session', 'credential', 'private',
];

function sanitize(data) {
  if (!data || typeof data !== 'object') return data;

  const sanitized = Array.isArray(data) ? [] : {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    // Redact if key contains any sensitive substring
    if (SENSITIVE_KEYS.some(sensitive => lowerKey.includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Recurse into nested objects
    if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitize(value);
      continue;
    }

    // Truncate long strings
    if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + '...[truncated]';
      continue;
    }

    sanitized[key] = value;
  }
  return sanitized;
}
```

Key design decisions:
- **Substring matching** (`.includes()`) catches variants like `myAccessToken`, `x_api_key`, `privateData` without maintaining an exhaustive list
- **Long string truncation** at 500 characters prevents large payloads from bloating audit storage
- **Recursive traversal** scrubs nested objects — PII hiding in deeply nested structures is still caught
- **Array support** — arrays are scrubbed element by element

### Tool Argument Summarization

A separate summarizer truncates tool arguments more aggressively for log readability:

```javascript
function summarizeArgs(args) {
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + '...[truncated]';
    } else if (Array.isArray(value)) {
      summary[key] = `[Array(${value.length})]`;
    } else if (typeof value === 'object' && value !== null) {
      summary[key] = '{Object}';
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
```

### Batched Non-Blocking Persistence

The flush interval is **5000ms** (5 seconds), with a maximum buffer size of 50 entries that triggers an immediate flush:

```javascript
// lib/audit/config.js
const FLUSH_INTERVAL = 5000;    // 5 seconds
const MAX_BUFFER_SIZE = 50;     // Immediate flush threshold

// lib/audit/state.js
function init(flushFn) {
  // Initialize S3-compatible client (DigitalOcean Spaces)
  s3Client = new S3Client({
    endpoint: `https://${spacesRegion}.digitaloceanspaces.com`,
    region: spacesRegion,
    credentials: { accessKeyId: spacesKey, secretAccessKey: spacesSecret },
  });

  flushTimer = setInterval(() => flushFn(), FLUSH_INTERVAL);

  // Flush on exit signals
  process.on('beforeExit', () => flushFn());
  process.on('SIGTERM', () => flushFn());
  process.on('SIGINT', () => flushFn());
}
```

### Execution Tracking Wrappers

The tracking module provides timing wrappers for tools, jobs, and requests:

```javascript
// lib/audit/tracking.js
async function trackTool(correlationId, toolName, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    log('tool:execute', { toolName, success: true }, {
      correlationId, durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    log('tool:execute', { toolName, success: false }, {
      correlationId, durationMs: Date.now() - start,
      status: 'error', error: err.message,
    });
    throw err;
  }
}

async function trackJob(jobName, fn) {
  const start = Date.now();
  log('job:start', { jobName });
  try {
    const result = await fn();
    log('job:complete', { jobName }, { durationMs: Date.now() - start });
    return result;
  } catch (err) {
    log('job:error', { jobName }, {
      durationMs: Date.now() - start, status: 'error', error: err.message,
    });
    throw err;
  }
}
```

## Implications

- The 5-second flush interval (not 2 seconds) means a crash within that window loses at most 5 seconds of audit data — acceptable for most orchestration use cases
- Substring matching (`.includes()`) is broader than exact key matching — `myAccessToken` is caught because `accesstoken` (lowercased) contains `token`. This trades some false positive risk on unusual keys for much better coverage
- Long string truncation at 500 characters prevents large LLM responses or base64 payloads from filling audit storage
- The S3-compatible storage (DigitalOcean Spaces) means audit logs are durable and queryable via prefix scanning
- Error entries trigger immediate flush (`buffer.length >= MAX_BUFFER_SIZE || options.status === 'error'`) so errors are never lost to buffering
- The 30-day retention (`RETENTION_DAYS = 30`) is enforced by a background maintenance job
- Alert thresholds (5 errors in 10 minutes) enable automated error rate monitoring

## Code Example

```javascript
const audit = require('./lib/audit');

// Simple logging with auto-correlation
audit.log('webhook.received', { source: 'github', event: 'push' });

// Tool execution tracking (auto-timed)
const result = await audit.trackTool('req_123', 'search_google', async () => {
  return await executeSearchGoogle(args);
});

// Job execution tracking
await audit.trackJob('morning-routine', async () => {
  await runMorningRoutine();
});

// Sanitization example
audit.sanitize({
  user: 'mike',
  apiKey: 'sk-1234',           // → '[REDACTED]' (contains 'apikey')
  myAccessToken: 'abc',        // → '[REDACTED]' (contains 'accesstoken')
  description: 'x'.repeat(600) // → truncated to 500 chars + '...[truncated]'
});
```

## Related Patterns

- [Request-Scoped Context Propagation](./request-scoped-context.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
