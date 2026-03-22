# Graceful Shutdown Ordering

> Ordered teardown sequence on SIGINT/SIGTERM ensuring data integrity, with per-phase timeouts and double-signal force exit.

## Problem

A process that handles background jobs, plugin lifecycle, web connections, and cognitive processing cannot just call `process.exit()`. In-flight evolution data is lost, plugins crash mid-operation, jobs leave orphaned locks, and connected clients get connection-reset errors. Without ordered shutdown, every restart risks data corruption and inconsistent state.

## Context

- Long-running Node.js process with multiple subsystems (web server, job runner, plugin host, cognitive processor)
- Evolution data and metrics must be flushed to persistent storage before exit
- Plugins need lifecycle teardown to release external resources
- Background jobs must complete or be cleanly returned to the queue
- Operators need a "force quit" escape hatch when graceful shutdown hangs

## Solution

SIGINT and SIGTERM handlers trigger the same ordered teardown sequence. Each phase runs in order with its own timeout — if a phase hangs, the next phase proceeds after the timeout expires. A second signal during shutdown forces immediate exit.

```javascript
// shutdown.js
const PHASES = [
  { name: 'flush-evolution', fn: () => evolutionStore.flush(), timeout: 5_000 },
  { name: 'stop-plugins',    fn: () => pluginManager.stopAll(), timeout: 10_000 },
  { name: 'stop-jobs',       fn: () => jobRunner.drain(),       timeout: 15_000 },
  { name: 'stop-server',     fn: () => httpServer.close(),      timeout: 5_000 },
  { name: 'stop-cognitive',  fn: () => cognitiveLoop.stop(),    timeout: 5_000 },
];

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) {
    logger.warn('Double signal received, forcing exit');
    process.exit(1);
  }

  shuttingDown = true;
  logger.info(`${signal} received, starting graceful shutdown`);

  for (const phase of PHASES) {
    try {
      await withTimeout(phase.fn(), phase.timeout);
      logger.info(`Phase ${phase.name} complete`);
    } catch (err) {
      logger.error(`Phase ${phase.name} failed or timed out`, { error: err.message });
    }
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

The phase order matters: evolution data is flushed first (highest data-loss risk), plugins stop before jobs (plugins may depend on job infrastructure), the web server stops before the cognitive processor (no new requests should arrive during final processing).

## Implications

- Phase ordering must reflect dependency relationships — stopping the web server before flushing data would lose in-flight request metrics
- Per-phase timeouts prevent a single hung subsystem from blocking the entire shutdown; but skipping a phase means that subsystem's cleanup is incomplete
- Double-signal force exit is a safety valve for operators, but it skips all remaining phases — use only when graceful shutdown is truly stuck
- The `shuttingDown` flag must be checked by subsystems that create new work (job dispatchers, queue consumers) to stop accepting work during teardown
- Container orchestrators (Docker, k8s) send SIGTERM then force-kill after a grace period — total phase timeouts should fit within that window

## Code Example

```javascript
// Integration: subsystems check shutdown state
class JobRunner {
  constructor() { this.draining = false; }

  async drain() {
    this.draining = true;
    // Wait for in-flight jobs to complete
    while (this.activeJobs.size > 0) {
      await sleep(500);
    }
    // Return unclaimed jobs to queue
    await this.requeuePending();
  }

  async dispatch(job) {
    if (this.draining) {
      logger.info('Rejecting job during shutdown', { jobId: job.id });
      return false;
    }
    // Normal dispatch...
  }
}
```

## Related Patterns

- [Plugin System and Hot-Reload](./plugin-system-and-hot-reload.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
