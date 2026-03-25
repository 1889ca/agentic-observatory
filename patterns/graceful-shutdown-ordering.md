# Graceful Shutdown Ordering

> Ordered teardown sequence on SIGINT/SIGTERM ensuring data integrity, with sequential phase execution and per-phase error isolation.

## Problem

A process that handles background jobs, plugin lifecycle, web connections, and cognitive processing cannot just call `process.exit()`. In-flight evolution data is lost, plugins crash mid-operation, jobs leave orphaned locks, and connected clients get connection-reset errors. Without ordered shutdown, every restart risks data corruption and inconsistent state.

## Context

- Long-running Node.js process with multiple subsystems (web server, job runner, plugin host, cognitive processor)
- Evolution data and metrics must be flushed to persistent storage before exit
- Plugins need lifecycle teardown to release external resources
- Background jobs must complete or be cleanly returned to the queue
- Operators need a "force quit" escape hatch when graceful shutdown hangs

## Solution

SIGINT and SIGTERM handlers trigger the same ordered teardown sequence. Each phase runs sequentially using `await` with a `.catch()` handler — if a phase throws, the error is logged and the next phase proceeds. There are no explicit per-phase timeout wrappers; phases are expected to complete or fail on their own. The signal handler is registered with `process.once()`, meaning a second signal uses the default OS behavior rather than a custom force-exit handler.

```javascript
// shutdown.js
const PHASES = [
  { name: 'flush-evolution', fn: () => evolutionStore.flush() },
  { name: 'stop-plugins',    fn: () => pluginManager.stopAll() },
  { name: 'stop-jobs',       fn: () => jobRunner.drain() },
  { name: 'stop-server',     fn: () => httpServer.close() },
  { name: 'stop-cognitive',  fn: () => cognitiveLoop.stop() },
];

async function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown`);

  for (const phase of PHASES) {
    await phase.fn().catch(err => {
      logger.error(`Phase ${phase.name} failed`, { error: err.message });
    });
    logger.info(`Phase ${phase.name} complete`);
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

The phase order matters: evolution data is flushed first (highest data-loss risk), plugins stop before jobs (plugins may depend on job infrastructure), the web server stops before the cognitive processor (no new requests should arrive during final processing).

## Implications

- Phase ordering must reflect dependency relationships — stopping the web server before flushing data would lose in-flight request metrics
- No per-phase timeouts means a hung subsystem blocks all subsequent phases — the container orchestrator's kill timeout is the only backstop
- `process.once()` means a second signal falls through to the OS default (typically immediate termination) rather than a custom force-exit handler
- The sequential `.catch()` pattern means phase failures are isolated but not timed — a phase that hangs indefinitely will block shutdown
- The `shuttingDown` flag is not used; subsystems that create new work should check their own state or rely on the sequential teardown to prevent new work during shutdown
- Container orchestrators (Docker, k8s) send SIGTERM then force-kill after a grace period — if any phase hangs, the force-kill is the only escape

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
