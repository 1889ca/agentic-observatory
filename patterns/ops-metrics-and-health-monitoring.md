# Ops Metrics and Health Monitoring

> In-process collection of event loop lag, per-endpoint latency histograms, and vector operation counters, surfaced through a single health check endpoint that aggregates subsystem status without any external metrics infrastructure.

## Problem

Observability for a Node.js service is often treated as an afterthought — a Prometheus sidecar, a StatsD daemon, or an APM agent bolted on later. But external agents add operational complexity and create gaps: if the process is stalling under backpressure, the external agent may report it as healthy because the health probe itself timed out gracefully. Latency regressions in specific endpoints are invisible if you only track aggregate response time. And embedding pipeline health — whether embeddings are being generated at all — is completely unobservable unless you instrument it explicitly.

The opposite failure mode is over-instrumentation: pulling in a full metrics library for a service that only needs to answer "is this healthy and is it keeping up?"

## Context

- A Node.js/Express API that fronts a vector database, Redis cache, and one or more LLM providers
- The embedding pipeline runs as part of request handling, not as a separate process, so its throughput is invisible to infrastructure-level monitors
- Event loop lag is the most important early indicator of overload, but Node's single-threaded model makes it impossible for the process itself to reliably detect stalls without a dedicated interval
- Teams want a single `/health` endpoint CI/CD and load balancers can poll — not a metrics scrape endpoint requiring a separate collection stack
- Latency data must survive restarts without a persistent store, so it is held in a rolling in-process buffer

## Solution

### Event Loop Lag Tracking

A recurring `setInterval` fires on a known interval. By comparing when the callback actually executes to when it was scheduled, the middleware derives lag — the amount of time the event loop was blocked between ticks:

```javascript
// lib/server/middleware.js
// Tracks how late the event loop timer fires relative to its scheduled interval
const INTERVAL_MS = 100;
let lastTick = Date.now();
let currentLagMs = 0;

setInterval(() => {
  const now = Date.now();
  currentLagMs = Math.max(0, now - lastTick - INTERVAL_MS);
  lastTick = now;
}, INTERVAL_MS).unref(); // .unref() so this interval doesn't keep the process alive
```

`.unref()` is essential — without it the process will not exit cleanly when the main workload is done.

### Per-Endpoint Latency Histograms

The Express middleware attaches a start timestamp to each request. On the response `finish` event, it computes duration and appends it to a per-endpoint ring buffer. p50/p95/p99 are computed on demand from the buffer:

```javascript
// lib/server/middleware.js
const latencyBuckets = new Map(); // endpoint -> number[]
const MAX_SAMPLES = 1000;

function recordLatency(endpoint, durationMs) {
  if (!latencyBuckets.has(endpoint)) {
    latencyBuckets.set(endpoint, []);
  }
  const bucket = latencyBuckets.get(endpoint);
  bucket.push(durationMs);
  // Keep the buffer bounded — drop oldest samples
  if (bucket.length > MAX_SAMPLES) bucket.shift();
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function getLatencyStats(endpoint) {
  const samples = (latencyBuckets.get(endpoint) || []).slice().sort((a, b) => a - b);
  if (!samples.length) return null;
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    count: samples.length,
  };
}

// Middleware — attaches timing and records on finish
function metricsMiddleware(req, res, next) {
  const startMs = Date.now();
  res.on('finish', () => {
    const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
    recordLatency(endpoint, Date.now() - startMs);
  });
  next();
}
```

Using `req.route?.path` (the route pattern, not the URL) groups all `/users/123` and `/users/456` calls under `GET /users/:id`, preventing the bucket map from growing without bound.

### Vector Operation Counters

The embedding pipeline increments counters each time it produces or fails to produce an embedding. These are plain in-process integers — no atomic primitives needed because Node.js is single-threaded:

```javascript
// lib/server/middleware.js
const vectorCounters = {
  embeddingsGenerated: 0,
  embeddingErrors: 0,
  vectorSearches: 0,
};

// Called from the embedding pipeline, not the HTTP layer
function incrementVectorCounter(key) {
  if (key in vectorCounters) vectorCounters[key]++;
}
```

### Health Check Endpoint

A single `/health` route queries each subsystem and assembles a composite response. If any critical subsystem fails, the response status is 503:

```javascript
// lib/server/middleware.js
async function healthHandler(req, res) {
  const checks = await Promise.allSettled([
    checkDatabase(),   // e.g., db.raw('SELECT 1')
    checkRedis(),      // e.g., redis.ping()
    checkLLMProvider(), // e.g., lightweight probe against the LLM API
  ]);

  const [db, redis, llm] = checks.map(r =>
    r.status === 'fulfilled' ? { ok: true } : { ok: false, error: r.reason?.message }
  );

  const healthy = db.ok && llm.ok; // Redis failure is degraded, not critical

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    eventLoopLagMs: currentLagMs,
    subsystems: { db, redis, llm },
    vectorCounters,
    // Latency snapshot for a representative set of endpoints
    latency: {
      'POST /api/query': getLatencyStats('POST /api/query'),
      'POST /api/embed': getLatencyStats('POST /api/embed'),
    },
  });
}
```

`Promise.allSettled` (not `Promise.all`) is deliberate: one failing subsystem should not prevent the health report from including data about the others.

## Implications

- No external metrics service is required. The process is entirely self-contained, which simplifies deployment and avoids a class of "metrics are up but app is down" failures.
- Latency histograms are approximate. The ring buffer holds recent samples only; percentiles reflect current behavior, not historical trends. For long-term trend analysis, scrape `/health` periodically and store externally.
- Event loop lag detection requires the interval to run on the same thread as request handling. If the process is completely locked, the interval cannot fire and lag appears as zero — the health check itself will time out, which is the correct observable behavior for a load balancer.
- Per-endpoint bucketing via route pattern prevents cardinality explosion, but requires Express route registration to be complete before the first request arrives. Dynamic or catch-all routes need explicit normalization.
- Vector counters reset on process restart. They are useful for rate-of-change monitoring within a session, not for cumulative lifetime statistics.
- The health endpoint should not require authentication — load balancers and readiness probes need to reach it without credentials — but it should be excluded from latency tracking to avoid skewing endpoint stats.

## Code Example

Full middleware registration in the Express app:

```javascript
// lib/server/middleware.js
// Register before routes so timing captures the full request lifecycle
app.use(metricsMiddleware);

// Register after routes so req.route is populated
app.get('/health', healthHandler);

// Expose counter increment for use by the embedding pipeline
module.exports = { incrementVectorCounter, getLatencyStats };
```

The embedding pipeline calls `incrementVectorCounter` directly:

```javascript
// lib/embeddings/pipeline.js
const { incrementVectorCounter } = require('../server/middleware');

async function embed(text) {
  try {
    const vector = await llmClient.embed(text);
    incrementVectorCounter('embeddingsGenerated');
    return vector;
  } catch (err) {
    incrementVectorCounter('embeddingErrors');
    throw err;
  }
}
```

## Related Patterns

- [Structured Logging with Child Loggers](./structured-logging-with-child-loggers.md) — health check failures and lag spikes should emit structured log entries through the same logging pipeline so operators get correlated context alongside metrics
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md) — subsystem health probes inside the health endpoint should tolerate the same optional-init contract as startup: if Redis never connected, the probe returns `ok: false` rather than throwing
- [Redis Optional Caching and Clustering](./redis-optional-caching-and-clustering.md) — the Redis health probe in the health endpoint is the runtime counterpart to Redis's optional initialization; both treat Redis as a non-critical dependency
