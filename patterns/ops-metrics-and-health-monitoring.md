# Ops Metrics and Health Monitoring

> Dedicated `lib/ops/metrics.js` module using `perf_hooks` for high-resolution timing, time-windowed sample buffers with configurable retention, and per-route/DB/job/dispatcher/vector metrics aggregated into a single snapshot.

## Problem

Observability for a Node.js service is often treated as an afterthought — a Prometheus sidecar or APM agent bolted on later. But external agents add operational complexity and create gaps: if the process is stalling under backpressure, the external agent may report it as healthy because the health probe itself timed out gracefully. Latency regressions in specific routes are invisible if you only track aggregate response time. And internal subsystem health — database query speed, job execution duration, vector search latency — is completely unobservable unless instrumented explicitly.

## Context

- A Node.js/Express API that fronts a PostgreSQL database, Redis cache, embedding pipeline, worker dispatcher, and job scheduler
- Event loop lag is the most important early indicator of overload
- Teams want a single `/ops/metrics` endpoint that returns a comprehensive snapshot — not a scrape endpoint requiring a separate collection stack
- Latency data must survive within a process session without a persistent store, held in rolling in-process buffers
- Different subsystems need different sample retention — HTTP requests need more samples than queue depth checks

## Solution

### Windowed Sample Buffers

The metrics module (`lib/ops/metrics.js`) uses a `makeWindow()` factory that creates time-bounded, size-bounded sample buffers. Old samples are pruned on every access:

```javascript
// lib/ops/metrics.js
const { performance } = require('perf_hooks')

const DEFAULT_WINDOW_MS = 5 * 60 * 1000     // 5-minute window
const DEFAULT_MAX_SAMPLES = 2000
const MAX_ROUTES = 40                         // Cap route cardinality

function makeWindow({ windowMs = DEFAULT_WINDOW_MS, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
  const samples = []

  const prune = (now) => {
    const cutoff = now - windowMs
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift()
    if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples)
  }

  return {
    add(value) {
      const now = Date.now()
      samples.push({ t: now, v: value })
      prune(now)
    },
    values() { prune(Date.now()); return samples.map((s) => s.v) },
    count()  { prune(Date.now()); return samples.length },
  }
}
```

Six dedicated windows track different subsystems, each with appropriate retention:

```javascript
const httpWindow     = makeWindow()                                          // 5min, 2000 samples
const contextWindow  = makeWindow()                                          // context assembly
const vectorWindow   = makeWindow()                                          // vector search
const eventLoopWindow = makeWindow({ maxSamples: 3000, windowMs: 2 * 60 * 1000 }) // 2min, 3000
const jobWindow      = makeWindow()                                          // job execution
const dbQueryWindow  = makeWindow({ maxSamples: 3000 })                      // DB queries
```

### Percentile Computation

Percentiles (p50, p95, p99) are computed on-demand from the windowed samples:

```javascript
// lib/ops/metrics.js
function quantile(values, q) {
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor((sorted.length - 1) * q)
  return sorted[idx]
}

function summarize(values) {
  if (!values || values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  return {
    count: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: Math.max(...values),
  }
}
```

### Per-Route HTTP Metrics

HTTP requests are tracked globally and per-route. Route paths are normalized to collapse dynamic segments (numeric IDs, UUIDs) into `:id` to prevent cardinality explosion:

```javascript
// lib/ops/metrics.js
function normalizePath(path) {
  if (!path) return 'unknown'
  let normalized = path
  normalized = normalized.replace(/\/\d+/g, '/:id')
  normalized = normalized.replace(/\/[0-9a-fA-F-]{8,}/g, '/:id')
  return normalized
}

function recordHttpRequest({ durationMs, method, path, statusCode }) {
  httpStats.total += 1
  httpWindow.add(durationMs)
  if (statusCode >= 500) httpStats.errors += 1
  httpStats.statusCounts[statusCode] = (httpStats.statusCounts[statusCode] || 0) + 1

  const routeKey = `${method} ${normalizePath(path)}`
  let routeEntry = httpStats.routes.get(routeKey)
  if (!routeEntry) {
    if (httpStats.routes.size >= MAX_ROUTES) {
      // Overflow bucket prevents unbounded growth
      routeEntry = httpStats.routes.get('OTHER') || { window: makeWindow({ maxSamples: 800 }) }
      httpStats.routes.set('OTHER', routeEntry)
    } else {
      routeEntry = { window: makeWindow({ maxSamples: 800 }) }
      httpStats.routes.set(routeKey, routeEntry)
    }
  }
  routeEntry.window.add(durationMs)
}
```

The `startHttpRequest()` helper uses `performance.now()` for high-resolution timing:

```javascript
function startHttpRequest() {
  httpStats.inflight += 1
  const start = performance.now()
  return (meta) => {
    const durationMs = performance.now() - start
    httpStats.inflight -= 1
    recordHttpRequest({ durationMs, ...meta })
  }
}
```

### Database Query Tracking

DB query metrics track total count, errors, latency distribution, and slow query detection:

```javascript
// lib/ops/metrics.js
function recordDbQuery({ durationMs, ok, slow, statement }) {
  dbStats.total += 1
  if (!ok) dbStats.errors += 1
  dbQueryWindow.add(durationMs)
  if (slow) {
    dbStats.slowCount += 1
    dbStats.lastSlow = { at: new Date().toISOString(), durationMs, statement }
  }
}
```

Connection pool stats are set externally by the DB module:

```javascript
function setDbPoolStats(stats) {
  dbPoolStats = { ...stats, updatedAt: new Date().toISOString() }
}
function setDbReadPoolStats(stats) {
  dbReadPoolStats = { ...stats, updatedAt: new Date().toISOString() }
}
```

### Job and Dispatcher Metrics

Job execution is tracked per-job-name with individual windows:

```javascript
// lib/ops/metrics.js
function recordJob({ name, durationMs, ok }) {
  jobStats.total += 1
  if (!ok) jobStats.errors += 1
  jobWindow.add(durationMs)

  let entry = jobStats.byName.get(name)
  if (!entry) {
    entry = { window: makeWindow({ maxSamples: 400 }), errors: 0, total: 0 }
    jobStats.byName.set(name, entry)
  }
  entry.total += 1
  if (!ok) entry.errors += 1
  entry.window.add(durationMs)
}

function recordDispatcherCycle({ durationMs, ok, dispatched }) {
  dispatcherStats = {
    lastRunAt: new Date().toISOString(),
    lastDurationMs: durationMs,
    lastOk: ok,
    lastDispatched: !!dispatched,
  }
}
```

### Event Loop Lag Monitor

A 1-second `setInterval` measures event loop lag by comparing actual execution time against expected:

```javascript
// lib/ops/metrics.js
function startEventLoopMonitor(intervalMs = 1000) {
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - intervalMs)
    eventLoopWindow.add(lag)
    last = now
  }, intervalMs)
  if (timer.unref) timer.unref()
}
```

### Queue Depth Sampling

Worker task queue depth and outbound queue status are sampled every 30 seconds:

```javascript
// lib/ops/metrics.js
async function refreshQueueStats() {
  const [worker, outbound] = await Promise.all([
    workerTasks.getStats(),
    outboundQueue.getStatus(),
  ])
  queueStats = {
    workerTasks: { pending: worker?.pending || 0, running: worker?.running || 0, stuck: worker?.stuck_count || 0 },
    outbound: outbound || null,
    updatedAt: new Date().toISOString(),
  }
}
```

### Unified Snapshot

A single `getSnapshot()` call assembles all metrics into a comprehensive object:

```javascript
// lib/ops/metrics.js
function getSnapshot() {
  return {
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    process: { memory: process.memoryUsage(), cpu: process.cpuUsage() },
    http: {
      inflight: httpStats.inflight,
      total: httpStats.total,
      errors: httpStats.errors,
      statusCounts: httpStats.statusCounts,
      latency: summarize(httpWindow.values()),
      routes: /* per-route summaries */,
    },
    context: { total: contextStats.total, latency: summarize(contextWindow.values()) },
    vectorSearch: { total: vectorStats.total, errors: vectorStats.errors, latency: summarize(vectorWindow.values()) },
    eventLoopLag: summarize(eventLoopWindow.values()),
    db: {
      pool: dbPoolStats,
      readPool: dbReadPoolStats,
      queries: { total: dbStats.total, errors: dbStats.errors, latency: summarize(dbQueryWindow.values()), slowCount: dbStats.slowCount, lastSlow: dbStats.lastSlow },
    },
    queues: queueStats,
    dispatcher: dispatcherStats,
    jobs: { total: jobStats.total, errors: jobStats.errors, latency: summarize(jobWindow.values()), byName: /* per-job summaries */ },
  }
}
```

## Implications

- No external metrics service is required — the process is entirely self-contained, simplifying deployment
- Windowed samples mean percentiles reflect current behavior (last 5 minutes), not historical trends — scrape the snapshot periodically for long-term analysis
- `MAX_ROUTES = 40` with an `OTHER` overflow bucket prevents unbounded memory growth from high-cardinality paths
- `perf_hooks.performance.now()` provides microsecond resolution without Date clock skew
- Event loop lag detection depends on the interval firing — if the process is completely frozen, the interval cannot fire and lag appears as zero (the health check itself times out, which is the correct signal for load balancers)
- Per-job-name breakdown enables identifying which specific jobs are slow or failing without external APM
- Queue depth is sampled (30s interval), not event-driven — spikes shorter than the sample interval are missed
- All counters reset on process restart — they measure rate-of-change within a session, not cumulative lifetime stats

## Code Example

```javascript
// Integration: Express middleware for HTTP metrics
const metrics = require('../ops/metrics')

app.use((req, res, next) => {
  const finish = metrics.startHttpRequest()
  res.on('finish', () => {
    finish({ method: req.method, path: req.path, statusCode: res.statusCode })
  })
  next()
})

// Integration: DB query instrumentation
const start = performance.now()
try {
  const result = await pool.query(sql, params)
  metrics.recordDbQuery({ durationMs: performance.now() - start, ok: true })
  return result
} catch (err) {
  metrics.recordDbQuery({ durationMs: performance.now() - start, ok: false })
  throw err
}

// Start background monitors on server boot
metrics.startBackgroundTasks()

// Expose snapshot via route
app.get('/ops/metrics', (req, res) => res.json(metrics.getSnapshot()))
```

## Related Patterns

- [Structured Logging with Child Loggers](./structured-logging-with-child-loggers.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Rate Limiting and API Protection](./rate-limiting-and-api-protection.md)
