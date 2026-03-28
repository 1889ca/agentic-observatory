# Structured Logging with Child Loggers

> Pino-based JSON logging with a single global `LOG_LEVEL`, per-module child loggers created via `child({ module: '...' })`, environment-aware pretty printing, and stdout-only output.

## Problem

Unstructured logging — `console.log('something happened')` — works until it doesn't. When multiple modules emit logs concurrently across async operations, flat text output becomes unreadable. Correlating a request's journey across modules requires manual grepping. Sensitive context (PID, environment, module origin) must be manually included in every log call, which means it's inconsistently present. In production, text logs resist automated parsing, making alerting and dashboards unreliable.

## Context

- A Node.js orchestrator with many modules (database, Redis, job scheduler, messenger, HTTP server, LLM providers, worker dispatch, etc.)
- Concurrent async operations make log interleaving a constant problem
- Production logs feed into a log aggregation system that expects structured JSON
- Development logs need to be human-readable without piping through external tools
- Module identification should appear automatically without manual tagging in every log call

## Solution

### Root Logger with Global Level

The core module creates a root Pino logger with a single global log level. There are no per-module level overrides — one `LOG_LEVEL` environment variable controls all output:

```javascript
// lib/logger.js
const pino = require('pino')

const isProduction = process.env.NODE_ENV === 'production'
const isDevelopment = !isProduction

// Single global level — no per-module overrides
const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug')

const usePrettyPrint = process.env.LOG_PRETTY === 'true' || isDevelopment

const baseConfig = {
  level: LOG_LEVEL,
  timestamp:
    pino.stdTimeFunctions?.isoTime ||
    (() => `,"time":"${new Date().toISOString()}"`),
  base: {
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
  },
}
```

### Environment-Aware Transport

In development, `pino-pretty` provides colorized, human-readable output. If `pino-pretty` is not installed (e.g., in a minimal production container), the logger falls back to standard JSON:

```javascript
// lib/logger.js
let transport = null
if (usePrettyPrint) {
  try {
    require.resolve('pino-pretty')
    transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{module} {msg}',
      },
    })
  } catch {
    // pino-pretty not installed — use default JSON
    transport = null
  }
}

const rootLogger = pino(baseConfig, transport)
```

The `messageFormat: '{module} {msg}'` ensures the module name appears inline in pretty output, making it easy to visually scan which module produced each line.

### Child Logger Factory

Every module creates a child logger by calling `child()` with a module binding. The child inherits the root's level and transport but tags every entry with the module name:

```javascript
// lib/logger.js
function child(bindings) {
  return rootLogger.child(bindings)
}

// Exported alongside direct logging methods
module.exports = {
  info: rootLogger.info.bind(rootLogger),
  warn: rootLogger.warn.bind(rootLogger),
  error: rootLogger.error.bind(rootLogger),
  debug: rootLogger.debug.bind(rootLogger),
  trace: rootLogger.trace.bind(rootLogger),
  fatal: rootLogger.fatal.bind(rootLogger),
  child,
  level: () => rootLogger.level,
  isLevelEnabled: (level) => rootLogger.isLevelEnabled(level),
  logger: rootLogger,
}
```

The root logger methods are exported directly so callers without a module context (startup code, one-off scripts) can log without creating a child.

### Module Usage Pattern

Every module follows the same two-line pattern to get a fully configured logger:

```javascript
// In any module
const logger = require('./logger').child({ module: 'redis' })

// All log calls automatically include { module: 'redis' }
logger.info('Initial connection established')
logger.warn({ delayMs: 1000, attempt: 3 }, 'Reconnecting')
logger.error({ err }, 'Client error')
```

This pattern is used consistently across the entire codebase. Representative child loggers include:

```javascript
// lib/redis.js
const logger = require('./logger').child({ module: 'redis' })

// lib/llm/providers/gemini.js
const logger = require('../../logger').child({ module: 'llm-gemini' })

// lib/worker/dispatch.js
const logger = require('../logger').child({ module: 'worker-dispatch' })

// lib/skills/matcher.js
const logger = require('../logger').child({ module: 'skill-matcher' })
```

### Output Formats

In development with `pino-pretty`:

```
2026-03-28 09:15:02.123 INFO  redis Initial connection established
2026-03-28 09:15:02.456 WARN  redis Reconnecting
    delayMs: 1000
    attempt: 3
```

In production, raw JSON to stdout:

```json
{"level":30,"time":"2026-03-28T09:15:02.123Z","pid":1234,"env":"production","module":"redis","msg":"Initial connection established"}
```

### No AsyncLocalStorage, No Per-Module Levels

The logger is intentionally simple. There is no `AsyncLocalStorage` mixin for correlation IDs — request tracing, if needed, is handled at a different layer. There are no per-module level overrides — the global `LOG_LEVEL` (defaulting to `debug` in development, `info` in production) applies uniformly. This keeps the logger fast and predictable.

## Implications

- Structured JSON enables automated alerting, dashboards, and querying in log aggregation systems — impossible with unstructured text
- A single global level is simpler to reason about than per-module overrides but means turning on debug for one noisy module affects all modules
- Child loggers are cheap in Pino (they share serializers and transport with the parent) — creating one per module adds negligible overhead
- The `pino-pretty` fallback means the logger works in any environment, even if `pino-pretty` is not installed — it just outputs JSON
- Writing only to stdout means the application never blocks on log I/O — log reliability is the platform's responsibility (Docker, systemd, log collectors)
- The exported root-level methods (`info`, `warn`, etc.) provide a convenience for code that does not belong to a specific module, but child loggers should be preferred for traceability
- No custom transports — log routing, filtering, and shipping are handled by the deployment environment

## Code Example

```javascript
// Typical module usage
const logger = require('../logger').child({ module: 'job-lock' })

async function tryAcquire(jobName) {
  logger.info({ jobName }, 'Attempting lock acquisition')

  try {
    const result = await acquireLock(jobName)
    if (result.acquired) {
      logger.info({ jobName, distributed: result.distributed }, 'Lock acquired')
    } else {
      logger.info({ jobName, reason: result.reason }, 'Skipping job: lock not acquired')
    }
    return result
  } catch (err) {
    logger.error({ err, jobName }, 'Lock acquisition failed')
    throw err
  }
}

// Output (production):
// {"level":30,"time":"...","pid":5678,"env":"production",
//  "module":"job-lock","jobName":"email-triage","msg":"Attempting lock acquisition"}
```

## Related Patterns

- [Ops Metrics and Health Monitoring](./ops-metrics-and-health-monitoring.md)
- [Audit Trail with PII Sanitization](./audit-trail-with-pii-sanitization.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
