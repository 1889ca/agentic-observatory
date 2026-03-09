# Scheduled Autonomous Maintenance

> Self-managing projects through cron-scheduled satellite tasks with orchestrator oversight.

## Problem

Software projects need ongoing maintenance — dependency updates, test runs, documentation freshness checks, pattern library curation. Doing this manually is tedious and gets forgotten. But fully autonomous maintenance is risky — an agent making unsupervised changes can introduce bugs or push broken code. You need a middle ground: automated scheduling with appropriate oversight.

## Context

- Multiple projects registered with a central orchestrator
- Each project has different maintenance needs and cadences
- Some maintenance is safe to auto-approve (linting, test runs, doc checks)
- Some requires human review before acting (dependency upgrades, refactors, deployments)
- The orchestrator itself needs maintenance (its own patterns, capabilities, health checks)

## Solution

### Cron-Based Task Scheduling

Tasks are registered with standard cron expressions and stored in SQLite:

```javascript
// Task definition
{
  id: 'observatory-maintenance',
  schedule: '0 2 * * *',        // Daily at 2 AM UTC
  prompt: 'Review and maintain the agentic-observatory project...',
  model: 'opus',
  workdir: '/path/to/project',
  enabled: true
}
```

The scheduler uses `node-cron` with guards against concurrent execution:

```javascript
const running = new Set();

cron.schedule(task.schedule, async () => {
  if (running.has(task.id)) return;  // Skip if already running
  running.add(task.id);
  try {
    const result = await runTask(task);  // Dispatch to satellite
    enqueue({ type: 'task-result', task: task.id, result });
  } finally {
    running.delete(task.id);
  }
});
```

### Autonomy Gating

Each project declares an autonomy matrix in `.riley/autonomy.yaml`:

```yaml
decisions:
  routine-logging:
    tier: status
    action: self-approve
  pattern-update:
    tier: opportunity
    action: self-approve
  deploy:
    tier: critical
    action: require_input

escalation_timeout: 3600  # seconds before auto-denying
```

Tiers control what the satellite can do without human approval:
- **Status tier:** Logging, reporting, monitoring — always safe
- **Opportunity tier:** Documentation updates, pattern additions — safe with review
- **Critical tier:** Deployments, data migrations, dependency changes — require human approval

### Self-Referential Maintenance

The pattern is recursive — the orchestrator schedules maintenance of its own supporting projects, including the pattern library that documents how the orchestrator works:

```
Orchestrator → schedules → observatory-maintenance task
  → satellite reviews patterns
  → satellite identifies gaps
  → satellite writes new patterns
  → satellite commits and pushes
  → (deployment requires human approval per autonomy.yaml)
```

This creates a self-documenting system where the patterns describing agentic behavior are themselves maintained by agents.

### Result Processing

All task results flow back through the orchestrator's queue:
- Results are enqueued with priority 1 (above ambient, below urgent)
- The orchestrator can act on results (relay to user, trigger follow-up flows)
- Failed tasks log errors but don't block other scheduled work
- No automatic retry — failed tasks wait for next scheduled run

## Implications

- Cron scheduling is coarse-grained — no event-driven triggers (e.g., "run on PR creation")
- Concurrent execution guard means long-running tasks can skip their next scheduled slot
- Autonomy gating relies on the satellite correctly classifying its actions — a satellite that "doesn't know" it's doing something critical can bypass the gate
- No dependency ordering between tasks — if task A must run before task B, that's the prompt author's problem
- Scheduled tasks consume satellite slots — heavy scheduling can starve on-demand work
- Escalation timeout (default 1 hour) means time-sensitive decisions may auto-deny

## Code Example

```javascript
// Registering a maintenance task via API
await fetch('http://localhost:3847/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'weekly-dep-audit',
    schedule: '0 9 * * 1',  // Monday 9 AM
    prompt: `Audit dependencies for security vulnerabilities.
             Check npm audit, review changelogs for major updates.
             Report findings but do NOT upgrade without approval.`,
    model: 'sonnet',
    workdir: '/path/to/project',
    enabled: true
  })
});

// Task runs automatically, results appear in orchestrator queue:
// "Found 2 moderate vulnerabilities in lodash and express.
//  lodash 4.17.21 → 4.17.25 (patch, safe to upgrade)
//  express 4.18.2 → 5.0.0 (major, breaking changes — needs review)
//  RECOMMENDATION: Auto-upgrade lodash, flag express for human review."
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Satellite Permission Escalation](./satellite-permission-escalation.md)
