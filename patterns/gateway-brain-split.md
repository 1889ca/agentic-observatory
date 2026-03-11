# Gateway-Brain Split

> Process isolation between the web-facing gateway and the AI brain for graceful degradation.

## Problem

A monolithic orchestrator is fragile. If the AI processing layer crashes — bad API response, memory leak, unhandled exception — it takes down the web UI, the API, and all connected clients. Users lose visibility into the system at exactly the moment they need it most. Similarly, frontend changes or static asset issues shouldn't require restarting the AI brain and losing in-flight conversations.

## Context

- A web-accessible orchestrator with both a UI and an API
- AI processing that can crash independently of the HTTP layer
- WebSocket connections for real-time updates
- Need for zero-downtime recovery from brain crashes
- Multiple consumers (UI, CLI, webhooks) sharing the same API

## Solution

### Two-Process Architecture

Split the system into two processes:

**Gateway** (port 3847): Handles all external communication:
- Serves static files (UI assets)
- Proxies API requests to the brain
- Manages WebSocket connections
- Controls brain process lifecycle (start, restart, health checks)
- Serves fallback UI if brain is down

**Brain** (port 3848): Handles all intelligence:
- API endpoints for messages, memory, flows, tasks
- AI model dispatch and session management
- WebSocket event broadcasting
- Database operations
- Background jobs (consolidation, scheduled tasks)

```javascript
// Gateway proxies all /api/* to brain
async function proxyToBrain(req, res) {
  try {
    const response = await fetch(`http://localhost:${BRAIN_PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
    res.writeHead(response.status, response.headers);
    response.body.pipe(res);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Brain is restarting...' }));
  }
}
```

### Automatic Recovery

The gateway monitors the brain process and restarts it on crash:

```javascript
function spawnBrain() {
  const brain = spawn('node', ['src/brain.js'], { stdio: 'pipe' });
  brain.on('exit', (code) => {
    if (code !== 0) {
      log(`Brain crashed (exit ${code}), restarting in 2s...`);
      setTimeout(spawnBrain, 2000);
    }
  });
  return brain;
}
```

### Fallback UI

If the brain is unreachable, the gateway serves an embedded recovery page instead of an error. This page shows system status, recent logs, and a manual restart button — giving the user visibility and control even during failures.

### WebSocket Bridging

The gateway maintains client WebSocket connections independently of the brain. When the brain restarts, the gateway reconnects its internal WS link to the new brain process and resumes forwarding events. Clients experience a brief pause in updates, not a disconnection.

## Implications

- Two processes add operational complexity (two things to monitor, two sets of logs)
- Inter-process communication via HTTP adds latency compared to in-process calls
- The gateway must handle the brain being unavailable for any API call — every proxy must have a timeout and fallback
- Static file serving in the gateway means UI deploys don't require brain restart
- Port conflicts are possible if another service binds the brain port during restart
- The gateway itself is now the single point of failure — but it's much simpler and less likely to crash

## Code Example

```javascript
// Gateway health check loop
setInterval(async () => {
  try {
    const res = await fetch(`http://localhost:${BRAIN_PORT}/api/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error(`Health check returned ${res.status}`);
    brainHealthy = true;
  } catch {
    brainHealthy = false;
    if (!brainProcess || brainProcess.exitCode !== null) {
      spawnBrain();
    }
  }
}, 10000);
```

## Related Patterns

- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
