# Flow Recovery and Resilience

> How to restart interrupted flows and maintain state consistency across orchestrator restarts.

## Problem

Flows break. Satellites crash, context windows fill up, permissions block, network drops. When a multi-step flow fails partway through, the orchestrator needs to know what completed, what didn't, and how to resume without re-doing finished work or corrupting state. Worse, the orchestrator itself might restart — it must recover in-flight flows from persistent state.

## Context

- Multi-step flows dispatched by an orchestrator to satellite workers
- Steps that have side effects (commits, API calls, file writes)
- Long-running operations that exceed CC session limits (45-minute timeout)
- Concurrent flows that share resources
- Orchestrator restarts (crashes, updates, system reboots)

## Solution

### State Machine with Persistent Checkpoints

Every flow is stored in SQLite with step-level progress:

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  project TEXT, flow_name TEXT,
  current_step INTEGER,      -- checkpoint: which step we're on
  iteration INTEGER,         -- for looping flows
  status TEXT,               -- running | paused | done | stopped | error
  context TEXT,              -- accumulated context across steps
  step_started_at TEXT,      -- when current step began
  job_id TEXT                -- satellite job running this step
);
```

Status transitions: `running → paused` (loop mode), `running → done` (all steps complete), `running → error` (unrecoverable failure), `running → stopped` (manual cancellation).

### Two-Part Recovery System

**1. Startup Reconnection (3-second delayed):**

On orchestrator restart, scan for flows with `status='running'`:

```javascript
// Query satellite for surviving jobs
const satStatus = await getSatelliteStatus();
const activeJobIds = new Set(satStatus.jobs.map(j => j.id));

for (const flow of runningFlows) {
  if (activeJobIds.has(flow.job_id)) {
    // Job survived restart — reconnect to it
    await subscribeToJob(flow.job_id, taskId, satId);
  } else if (stepAge < 2 * 60 * 1000) {
    // Young step, might still start — wait
  } else {
    // Old step, job is dead — retry from this step
    await executeStep(flow.id);
  }
}
```

**2. Watchdog Loop (every 60 seconds):**

Continuous health check for active flows:
- Dead child process detection: if `!isRunActive(taskId)`, retry the step
- Stale step detection: steps running >50 minutes get cancelled and marked as error
- Orphan cleanup: flows stuck in `running` with no active child for >50 minutes

### Loop and Gate Control

Flows support three completion modes:

- **Single pass** (default): Run all steps once, mark done
- **Loop mode** (`on_complete: 'loop'`): Pause after each cycle, wait for manual resume via API
- **Gate mode** (`on_complete: 'gate'`): Autonomous looping — parse final step output for STOP/CONTINUE keywords. Capped by `max_iterations` (default 10)

```javascript
// Gate mode decision logic
const tail = output.slice(-500);
if (/\bSTOP\b/i.test(tail)) {
  markDone(flowId);
} else if (/\bCONTINUE\b/i.test(tail)) {
  loop(flowId, output); // output becomes new context
}
```

### Context Threading

Each step receives interpolated context:
- `{context}` — the original flow context (from `startFlow()`)
- `{prev_output}` — output from the previous step

This enables multi-step pipelines where each step builds on the last without the orchestrator needing to understand the domain.

### Guard Against Duplicate Execution

An in-memory `executingFlows` Map prevents race conditions:

```javascript
if (executingFlows.has(flowId)) return; // already running
executingFlows.set(flowId, taskId);
```

## Implications

- Step-level granularity means partial side effects from a failed step may need manual cleanup
- The 50-minute hard timeout is slightly above the satellite's 45-minute limit, creating a small window where both timeout mechanisms fire
- Reconnection after restart only works if the satellite worker daemon survived — if both crash, jobs are lost
- Gate mode's keyword parsing is fragile — agents must reliably emit STOP/CONTINUE in their final output
- No rollback mechanism for completed steps — idempotent step design is the author's responsibility
- SQLite single-writer constraint means flow operations are serialized

## Code Example

```javascript
// Sub-flow delegation — steps can spawn nested flows
if (step.run_flow) {
  const subId = `${project}:${step.run_flow}:sub:${Date.now()}`;
  await startFlow(project, step.run_flow, context);
  // Poll until sub-flow completes
  const poll = setInterval(async () => {
    const sub = getFlow(subId);
    if (sub.status === 'done') {
      clearInterval(poll);
      advanceFlow(flowId, sub.context);
    } else if (sub.status === 'error') {
      clearInterval(poll);
      markError(flowId, 'Sub-flow failed');
    }
  }, 5000);
}
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
