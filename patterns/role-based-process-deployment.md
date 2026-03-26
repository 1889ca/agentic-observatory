# Role-Based Process Deployment

> Split web and job processes at startup using a `ROLE` environment variable so each instance runs only what it needs.

## Problem

Running HTTP servers and background job workers in the same process wastes resources and complicates horizontal scaling. Scaling web capacity also scales job workers — and duplicate cognitive processing loops running across instances cause race conditions and redundant work.

## Context

Applies when a Node.js application serves both HTTP traffic and runs background jobs or an autonomous processing loop. The system needs to scale web instances independently of job workers, and the cognitive loop must run exactly once regardless of how many web instances are active.

## Solution

At startup, read `process.env.ROLE` (defaulting to `'all'`) and conditionally initialize subsystems:

- `web` — starts Express, Socket.io, and API routes. Does not start job runners or the cognitive loop.
- `jobs` — starts job runners, the cognitive processing loop, and scheduled tasks. Does not bind an HTTP port.
- `all` — starts everything. Used in development and single-instance deployments.

The split is implemented with plain `if`-checks in `index.js`. No plugin system or dynamic loader — the logic is explicit and readable at a glance:

```js
// index.js
const role = process.env.ROLE || 'all';

if (role === 'web' || role === 'all') {
  startHttpServer();   // Express + Socket.io + API routes
}

if (role === 'jobs' || role === 'all') {
  startJobRunners();        // Queue consumers, scheduled tasks
  startCognitiveLoop();     // Autonomous processing — runs once per deployment
}
```

A process manager (e.g., PM2) defines one process entry per role, letting each be restarted, scaled, and deployed independently. Multiple `web` instances run behind a load balancer while a single `jobs` instance handles all background work, ensuring the cognitive loop runs exactly once.

## Implications

- Cognitive processing and job runners are never duplicated across web instances.
- Web and job processes can be restarted, scaled, or deployed independently without touching each other.
- Local development uses `ROLE=all` (or omits it) to run everything in one process.
- The single `jobs` instance is a bottleneck if job throughput needs to scale; address this by partitioning job queues before adding more `jobs` instances, not by removing the role split.
- Graceful shutdown must account for which subsystems are running — a `web` process should drain HTTP connections; a `jobs` process should finish in-flight jobs before exiting.

## Related Patterns

- [Graceful Shutdown Ordering](./graceful-shutdown-ordering.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
