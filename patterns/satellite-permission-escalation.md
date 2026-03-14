# Satellite Permission Escalation

> Handling permission boundaries in multi-agent dispatch so blocked workers report why, not just that they failed.

## Problem

When an orchestrator dispatches work to AI agent workers (e.g., Claude Code instances), those workers operate within permission boundaries — tool restrictions, file access limits, network constraints, approval gates. From the orchestrator's perspective, a permission block is indistinguishable from a crash or timeout: the worker simply stops producing output. This creates silent failures where the orchestrator retries work that can never succeed, wastes worker slots, and has no diagnostic signal to inform alternative strategies.

## Context

- Multi-agent systems where an orchestrator dispatches tasks to AI agent workers
- Workers running with varying permission configurations (full auto-accept, selective approval, manual-only)
- Long-running tasks that span multiple tool categories (file reads, writes, shell execution, network access)
- Workers that cannot programmatically grant themselves additional permissions mid-session
- Need to distinguish between "worker is stuck on permissions" and "worker crashed" and "worker is just slow"

## Solution

### Structured Failure Reporting

The key insight: workers must communicate **why** they're blocked, not just that they're blocked. Define a failure taxonomy that distinguishes permission blocks from other failure modes:

```javascript
// Worker reports structured failure, not just exit code
function reportFailure(jobId, failure) {
  return {
    jobId,
    status: 'blocked',
    reason: failure.type,     // 'permission_denied' | 'timeout' | 'crash' | 'resource_limit'
    detail: failure.message,  // 'Write access to /etc/nginx required'
    toolCategory: failure.tool, // 'bash' | 'edit' | 'write' | 'network'
    recoverable: failure.recoverable // Can this be retried with different config?
  };
}
```

### Stall Detection

Workers that hit permission prompts don't crash — they hang waiting for input. The orchestrator must detect this via activity monitoring, not just exit codes:

```javascript
function detectStalls(activeJobs) {
  const now = Date.now();
  for (const job of activeJobs) {
    const silentDuration = now - job.lastActivityAt;

    if (silentDuration > STALL_THRESHOLD_MS) {
      // Worker has been silent too long — likely permission-blocked
      job.status = 'suspected_permission_block';
      emitAlert(job);
    }
  }
}

// Run detection periodically
setInterval(() => detectStalls(getActiveJobs()), 60000);
```

### Permission Requirement Declaration

Task definitions can declare expected permission categories upfront. The orchestrator validates compatibility before dispatch, avoiding predictable failures:

```javascript
const task = {
  id: 'apply-fixes',
  prompt: 'Apply the suggested code fixes',
  requiredPermissions: ['read', 'edit', 'write', 'bash'],
};

function canWorkerHandle(worker, task) {
  const workerPermissions = worker.permissionProfile;
  const missing = task.requiredPermissions.filter(
    p => !workerPermissions.includes(p)
  );
  if (missing.length > 0) {
    return { compatible: false, missing };
  }
  return { compatible: true };
}
```

### Fallback Strategies

When a permission block is detected, the orchestrator has several options depending on the failure context:

1. **Retry with elevated config**: Redispatch the job to a worker with broader permissions
2. **Decompose the task**: Break the blocked step into smaller sub-steps that require fewer permissions (e.g., separate "analyze" from "apply")
3. **Escalate to human**: Route the blocked task to a human-in-the-loop queue with the specific permission context
4. **Skip and continue**: If the blocked step is optional, mark it as skipped and proceed with the flow

```javascript
async function handlePermissionBlock(job, failure) {
  switch (failure.toolCategory) {
    case 'bash':
      // Shell access often blocked — try decomposing into safer operations
      return await decomposeTask(job, { avoid: ['bash'] });
    case 'write':
      // File write blocked — escalate with context
      return await escalateToHuman(job, {
        reason: `Worker needs write access to ${failure.detail}`,
        suggestion: 'Approve write permissions or apply changes manually'
      });
    default:
      // Unknown block — retry with elevated worker
      return await redispatch(job, { permissionLevel: 'elevated' });
  }
}
```

## Implications

- Stall detection has inherent latency (polling interval) — fast-failing is preferable but not always possible with interactive permission models
- Pre-dispatch permission checking requires upfront declaration of expected tool usage, adding authoring overhead to task definitions
- No way to programmatically grant permissions mid-session in most AI agent runtimes — blocked workers must be restarted with new config
- The decomposition strategy (breaking tasks into smaller steps) may produce worse results than a single cohesive execution
- Human escalation requires a notification system and queue — adds infrastructure beyond the orchestrator itself
- Permission profiles vary by runtime (Claude Code, OpenAI Codex, etc.) — the abstraction layer must account for different permission models

## Code Example

```javascript
// Complete permission-aware dispatch cycle
async function dispatchWithPermissionHandling(job, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const worker = findCompatibleWorker(job);
    if (!worker) {
      // No worker has sufficient permissions
      return await escalateToHuman(job, {
        reason: `No worker available with permissions: ${job.requiredPermissions}`
      });
    }

    const result = await dispatchAndMonitor(worker, job);

    if (result.status === 'complete') {
      return result;
    }

    if (result.status === 'blocked' && result.reason === 'permission_denied') {
      log(`Job ${job.id} blocked on ${result.toolCategory} — attempt ${attempt + 1}`);

      if (result.recoverable) {
        // Elevate permissions and retry
        job.requiredPermissions.push(result.toolCategory);
        continue;
      } else {
        return await handlePermissionBlock(job, result);
      }
    }

    // Non-permission failure — don't retry
    throw new Error(`Job ${job.id} failed: ${result.detail}`);
  }

  return await escalateToHuman(job, { reason: 'Max retries exceeded on permission blocks' });
}
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
