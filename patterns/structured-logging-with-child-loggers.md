# Structured Logging with Child Loggers

> Pino-based JSON logging with per-module child loggers, configurable levels, environment metadata in every entry, and AsyncLocalStorage integration for correlation IDs.

## Problem

Unstructured logging — `console.log('something happened')` — works until it doesn't. When multiple modules emit logs concurrently across async operations, flat text output becomes unreadable. Correlating a request's journey across modules requires manual grepping. Debug-level logs from a noisy module drown out important messages from others, but the only control is a global level that's all-or-nothing. In production, text logs resist automated parsing, making alerting and dashboards unreliable. And sensitive context (PID, environment, module origin) must be manually included in every log call, which means it's inconsistently present.

## Context

- A Node.js orchestrator with many modules (database, Redis, job scheduler, messenger, HTTP server, etc.)
- Concurrent async operations make log interleaving a constant problem
- Different modules need different log verbosity — the database layer at debug during a migration issue, everything else at info
- Production logs feed into a log aggregation system (ELK, Datadog, etc.) that expects structured JSON
- Development logs need to be human-readable without piping through external tools
- Request-scoped correlation IDs must appear in log entries without passing them through every function call

## Solution

### Logger Factory with Automatic Metadata

The core module creates a root Pino logger with base metadata that appears in every log entry. Child loggers are created per module, automatically tagging every entry with the module name:

```typescript
// lib/logger.ts
import pino, { Logger, LoggerOptions } from 'pino';

const IS_DEV = process.env.NODE_ENV !== 'production';

const rootOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  base: {
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(IS_DEV && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
};

const root: Logger = pino(rootOptions);

/**
 * Create a child logger for a specific module.
 * Every log entry from this logger includes { module: name }.
 */
export function createLogger(moduleName: string): Logger {
  const level = getModuleLevel(moduleName);
  const child = root.child({ module: moduleName });

  if (level) {
    child.level = level;
  }

  return child;
}
```

### Per-Module Log Levels

Different modules can run at different log levels. This is configured via environment variables — a comma-separated list of `module=level` overrides:

```typescript
// LOG_LEVELS="lib/db=debug,lib/redis=warn,lib/scheduler=trace"
const MODULE_LEVELS: Record<string, string> = {};

function parseModuleLevels(): void {
  const config = process.env.LOG_LEVELS || '';
  if (!config) return;

  for (const entry of config.split(',')) {
    const [module, level] = entry.trim().split('=');
    if (module && level) {
      MODULE_LEVELS[module] = level;
    }
  }
}

parseModuleLevels();

function getModuleLevel(moduleName: string): string | undefined {
  // Exact match first
  if (MODULE_LEVELS[moduleName]) return MODULE_LEVELS[moduleName];

  // Prefix match: 'lib/db' matches 'lib/db/migrate'
  for (const [prefix, level] of Object.entries(MODULE_LEVELS)) {
    if (moduleName.startsWith(prefix)) return level;
  }

  return undefined; // Use root level
}
```

### Correlation ID Integration via AsyncLocalStorage

Log entries automatically include the request correlation ID when one is set in the current async context. This uses `AsyncLocalStorage` — no parameter drilling required:

```typescript
import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  correlationId: string;
  userId?: string;
}

const asyncContext = new AsyncLocalStorage<RequestContext>();

// Pino mixin: runs on every log call, injecting context from AsyncLocalStorage
const rootOptionsWithMixin: LoggerOptions = {
  ...rootOptions,
  mixin() {
    const ctx = asyncContext.getStore();
    if (!ctx) return {};

    return {
      correlationId: ctx.correlationId,
      ...(ctx.userId && { userId: ctx.userId }),
    };
  },
};
```

The mixin runs synchronously on every log call. When there's no active async context (background tasks, startup logging), it returns an empty object — no extra fields, no errors.

### Request Context Middleware

The HTTP server middleware establishes the async context for each request, generating or extracting a correlation ID:

```typescript
import { randomUUID } from 'crypto';

function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId =
    (req.headers['x-correlation-id'] as string) || randomUUID();

  // Set on response for client visibility
  res.set('X-Correlation-ID', correlationId);

  const context: RequestContext = {
    correlationId,
    userId: req.user?.id,
  };

  asyncContext.run(context, () => next());
}

app.use(requestContextMiddleware);
```

### Output Formats

In development, `pino-pretty` produces human-readable colorized output:

```
14:23:07 INFO  [lib/scheduler]: Running job morning-review
    correlationId: "abc-123"
14:23:07 DEBUG [lib/db]: Query executed in 12ms
    correlationId: "abc-123"
    sql: "SELECT * FROM tasks WHERE status = $1"
```

In production, raw JSON goes to stdout for log aggregation:

```json
{"level":30,"time":"2025-03-15T14:23:07.123Z","pid":1234,"env":"production","module":"lib/scheduler","correlationId":"abc-123","msg":"Running job morning-review"}
```

### Log Levels and Their Usage

The six standard Pino levels, with conventions for when to use each:

```typescript
const logger = createLogger('lib/example');

// trace: ultra-verbose, function entry/exit, loop iterations
logger.trace({ input }, 'Processing item');

// debug: internal state useful during development or debugging
logger.debug({ queryMs: 12, sql }, 'Query executed');

// info: normal operational events — startup, job completion, config loaded
logger.info({ jobName }, 'Job completed successfully');

// warn: unexpected but recoverable — fallback used, retry needed, deprecated usage
logger.warn({ attempt: 3 }, 'Redis reconnection attempt');

// error: operation failed — includes error object for stack trace
logger.error({ err, taskId }, 'Task execution failed');

// fatal: process cannot continue — about to exit
logger.fatal({ err }, 'Unrecoverable error — shutting down');
```

### No Custom Transports

The logger writes to stdout exclusively. Log routing, filtering, and shipping are handled by the deployment environment (Docker log driver, systemd journal, log collector sidecar). This keeps the application simple and avoids the reliability issues of in-process log shipping:

```typescript
// In production: raw JSON to stdout
// Docker/k8s/systemd captures stdout
// Log collector (Filebeat, Fluentd, Vector) ships to aggregation

// In development: pino-pretty to stdout
// Developer reads directly in terminal
```

## Implications

- Structured JSON enables automated alerting, dashboards, and querying in log aggregation systems — impossible with unstructured text
- Per-module levels let developers increase verbosity for a specific module during debugging without being drowned by noise from others
- The `mixin` function runs on every log call — it must be fast. AsyncLocalStorage lookup is O(1) so this is safe, but custom mixins should avoid I/O
- Child loggers are cheap in Pino (they share serializers and transport with the parent) — creating one per module is fine
- `pino-pretty` is a dev dependency only — it should not be in the production bundle
- The correlation ID bridges log entries across modules for a single request, making distributed tracing possible without a full tracing framework
- Writing only to stdout means the application never blocks on log I/O (no file rotation, no network calls) — log reliability is the platform's responsibility
- Fatal-level logs should be paired with a `process.exit(1)` — Pino doesn't exit for you

## Code Example

```typescript
// Usage in a module — two lines to get a fully configured logger
import { createLogger } from '../lib/logger';

const logger = createLogger('lib/scheduler');

async function executeJob(jobName: string): Promise<void> {
  logger.info({ jobName }, 'Starting job execution');

  const startTime = Date.now();

  try {
    const result = await runJobByName(jobName);

    logger.info(
      { jobName, durationMs: Date.now() - startTime, result: result.summary },
      'Job completed'
    );
  } catch (err) {
    logger.error(
      { err, jobName, durationMs: Date.now() - startTime },
      'Job failed'
    );
    throw err;
  }
}

// Output in production (with correlation ID from the triggering request):
// {"level":30,"time":"2025-03-15T09:00:01.234Z","pid":5678,"env":"production",
//  "module":"lib/scheduler","correlationId":"req-abc-123",
//  "jobName":"morning-review","msg":"Starting job execution"}
```

## Related Patterns

- [Request-Scoped Context Propagation](./request-scoped-context.md)
- [Audit Trail with PII Sanitization](./audit-trail-with-pii-sanitization.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
