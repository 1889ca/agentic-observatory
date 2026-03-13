# Gateway-Brain Split

> Process isolation between web-facing gateway and AI-processing layers for independent scaling and graceful degradation.

## Problem

A monolithic orchestrator is fragile. If the AI processing layer crashes — bad API response, memory leak, unhandled exception — it takes down the web UI, the API, and all connected clients. Users lose visibility into the system at exactly the moment they need it most. Similarly, frontend changes or static asset issues shouldn't require restarting the AI dispatch engine and losing in-flight conversations.

## Context

- A web-accessible orchestrator with both a UI and an API
- AI processing that involves long-running operations, external API calls, or resource-intensive work that may crash independently
- WebSocket connections for real-time updates to multiple consumers (UI, CLI, webhooks)
- Need for zero-downtime recovery from brain crashes
- Systems where the gateway layer is simple and stable, but the AI layer is complex and evolving
- Note: when the orchestrator is simple enough (few integration points, low request volume), a monolithic single-process deployment may be preferable — the split adds operational overhead that isn't always justified

## Solution

Split the system into two independently deployable processes:

**Gateway**: Handles all external-facing communication — serves static assets, manages WebSocket connections, proxies API requests to the brain, controls brain lifecycle (start, restart, health checks), and serves a fallback UI if the brain is unreachable.

**Brain**: Handles all intelligence — API endpoint logic, AI model dispatch, session management, database operations, background jobs, and event broadcasting.

The gateway proxies all API traffic to the brain and handles failures with structured fallbacks:

```javascript
// Gateway proxies API requests to the brain process
async function proxyToBrain(req, res) {
  try {
    const response = await fetch(`http://localhost:${brainPort}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(30000)
    });
    res.writeHead(response.status, response.headers);
    response.body.pipe(res);
  } catch (err) {
    // Brain is down — return structured error, not a crash
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Brain process is restarting...' }));
  }
}
```

### Automatic Recovery

The gateway monitors the brain process and restarts it on crash. The brain is treated as a managed child process with exponential backoff:

```javascript
function spawnBrain(retryDelay = 2000) {
  const brain = spawn('node', ['src/brain.js'], { stdio: 'pipe' });

  brain.on('exit', (code) => {
    if (code !== 0) {
      log(`Brain crashed (exit ${code}), restarting in ${retryDelay}ms...`);
      setTimeout(() => spawnBrain(Math.min(retryDelay * 2, 30000)), retryDelay);
    }
  });

  return brain;
}
```

### WebSocket Bridging

The gateway maintains client WebSocket connections independently of the brain. When the brain restarts, the gateway reconnects its internal link to the new brain process and resumes forwarding events. Clients experience a brief pause in updates, not a full disconnection.

### Fallback UI

If the brain is unreachable, the gateway serves an embedded recovery page showing system status, recent logs, and a manual restart button — giving users visibility and control during failures.

## Implications

- Two processes add operational complexity: two sets of logs, two things to monitor, two deployment targets
- Inter-process communication via HTTP adds latency compared to in-process function calls
- Every proxied request must have a timeout and fallback — the gateway can never assume the brain is healthy
- Static file serving in the gateway means UI deploys don't require brain restart
- The gateway itself becomes the single point of failure, but it's deliberately kept simple and stable
- For orchestrators with limited scope (few projects, single user), a monolithic deployment avoids this complexity entirely — the split pays off when the AI layer is unstable or needs independent scaling

## Code Example

```javascript
// Gateway health check loop — detects brain failures and triggers restart
setInterval(async () => {
  try {
    const res = await fetch(`http://localhost:${brainPort}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error(`Health returned ${res.status}`);
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
