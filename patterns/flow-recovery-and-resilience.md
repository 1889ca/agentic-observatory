# Flow Recovery and Resilience

> Persist flow state at each step so multi-step agent pipelines can resume after crashes without re-executing completed work.

## Problem

Multi-step agent pipelines break. Workers crash, context windows fill up, network connections drop, permissions block. When a flow fails partway through, the orchestrator needs to know what completed, what didn't, and how to resume without re-doing finished work or corrupting state. Worse, the orchestrator itself might restart — it must recover in-flight flows from persistent state, not just in-memory data structures.

## Context

- Multi-step flows dispatched by an orchestrator to worker agents
- Steps that have side effects (commits, API calls, file writes) and cannot safely be re-run
- Long-running operations that may exceed worker session limits
- Concurrent flows that share resources
- Orchestrator restarts (crashes, updates, system reboots)

## Solution

### State Machine with Persistent Checkpoints

Every flow is tracked in a database with step-level progress. The schema captures enough to resume from any point:

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  project TEXT,
  flow_name TEXT,
  current_step INTEGER,
  iteration INTEGER DEFAULT 0,
  status TEXT CHECK (status IN ('running', 'paused', 'done', 'stopped', 'error')),
  context TEXT,
  step_started_at TIMESTAMPTZ,
  job_id TEXT
);
```

Status transitions follow a simple state machine: `running -> paused` (loop mode cycle complete), `running -> done` (all steps complete), `running -> error` (unrecoverable failure), `running -> stopped` (manual cancellation). Any terminal state can be manually reset to `running` for retry.

### Two-Part Recovery System

Recovery happens at two timescales:

**1. Startup Reconnection:** On orchestrator restart, query for flows with `status='running'` and check which worker jobs are still alive:

```javascript
const activeJobs = await getActiveWorkerJobs();
const activeJobIds = new Set(activeJobs.map(j => j.id));

for (const flow of runningFlows) {
  if (activeJobIds.has(flow.job_id)) {
    // Job survived the restart — reconnect and monitor it
    await reconnectToJob(flow.job_id);
  } else if (stepAge < GRACE_PERIOD_MS) {
    // Recently started step — may still be spinning up, skip for now
  } else {
    // Stale step with no live worker — retry from current step
    await executeStep(flow.id, flow.current_step);
  }
}
```

**2. Periodic Watchdog:** A background loop (e.g., every 60 seconds) monitors active flows:
- Detects dead worker processes and retries their steps
- Cancels steps that exceed a timeout threshold (e.g., 50 minutes)
- Cleans up orphaned flows stuck in `running` with no active worker

### Loop and Gate Control Modes

Flows support three completion modes:

- **Single pass** (default): Run all steps once, mark done
- **Loop mode** (`on_complete: 'loop'`): Pause after each cycle, wait for external resume signal via API
- **Gate mode** (`on_complete: 'gate'`): Autonomous looping — parse the final step's output for STOP/CONTINUE signals. Capped by `max_iterations` to prevent runaway loops

```javascript
// Gate mode: the agent decides whether to loop
const tail = output.slice(-500);
if (/\bSTOP\b/i.test(tail)) {
  await updateFlowStatus(flowId, 'done');
} else if (/\bCONTINUE\b/i.test(tail)) {
  await loopFlow(flowId, output); // output becomes next iteration's context
}
```

### Context Threading Between Steps

Each step's prompt template supports interpolation variables:
- `{context}` — the original flow context provided at creation
- `{prev_output}` — the output from the previous step

This enables pipelines where each step builds on the last without the orchestrator needing domain knowledge. The orchestrator just threads data forward.

### Duplicate Execution Guard

An in-memory lock prevents race conditions between the watchdog and reconnection logic:

```javascript
if (executingFlows.has(flowId)) return;
executingFlows.set(flowId, jobId);
```

## Implications

- Step-level granularity means a failed step's partial side effects may need manual cleanup — there is no automatic rollback
- Reconnection only works if the worker survived the orchestrator's restart. If both crash, the watchdog handles retry on next tick
- Gate mode depends on the agent reliably emitting STOP/CONTINUE keywords — fragile if the agent's output format varies
- Idempotent step design is the flow author's responsibility, since steps may be retried
- Sub-flows (steps that spawn nested flows) add complexity: the parent flow must poll or subscribe to the child's completion

## Code Example

```javascript
// Reference implementation: Riley orchestrator (PostgreSQL-backed)

// Starting a flow
const flowId = `${project}:${flowName}:${Date.now()}`;
await db.query(
  `INSERT INTO flows (id, project, flow_name, current_step, status, context)
   VALUES ($1, $2, $3, 0, 'running', $4)`,
  [flowId, project, flowName, JSON.stringify(context)]
);
await executeStep(flowId, 0);

// Advancing to next step after completion
async function advanceFlow(flowId, prevOutput) {
  const flow = await getFlow(flowId);
  const nextStep = flow.current_step + 1;

  if (nextStep >= flow.steps.length) {
    await handleFlowCompletion(flowId, prevOutput); // done, loop, or gate
    return;
  }

  await db.query(
    `UPDATE flows SET current_step = $1, step_started_at = NOW() WHERE id = $2`,
    [nextStep, flowId]
  );
  await executeStep(flowId, nextStep);
}
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
