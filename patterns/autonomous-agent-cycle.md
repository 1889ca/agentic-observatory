# Autonomous Agent Cycle

> Priority-driven action cycle with working hours, autonomy tiers, and batch approval for self-directed agent behavior.

## Problem

An AI orchestrator that only responds to user messages is reactive — it waits idle between interactions. But a capable system should proactively maintain projects, triage incoming work, and execute scheduled improvements without being asked. The challenge is doing this safely: autonomous actions need priority ordering, working-hours awareness, undo capability, and human oversight gates that scale from "approve everything" to "fully autonomous."

## Context

- An orchestrator with access to project state, task queues, and external services
- Need for proactive behavior (maintenance, monitoring, follow-ups) beyond reactive chat
- Human oversight requirements that vary by action risk level
- Time-of-day awareness to avoid disruptive actions during off-hours
- Multiple concurrent projects with competing priorities

## Solution

### The Agent Cycle

The autonomous cycle runs continuously during working hours, evaluating and executing actions:

```
┌──────────────────────────────────────────┐
│              AGENT CYCLE                  │
│                                          │
│  Priority Scan → Strategy → Action →     │
│  Execution → Observe → (loop)            │
│                                          │
│  ┌─ Working hours gate                   │
│  ├─ Autonomy tier check                  │
│  └─ Approval queue for gated actions     │
└──────────────────────────────────────────┘
```

### Priority Scan

Each cycle begins by scanning all registered projects and queues for actionable items:

```javascript
async function scanPriorities() {
  const items = [];

  // Check all registered project queues
  for (const project of projects.getAll()) {
    const tasks = await project.getPendingTasks();
    items.push(...tasks.map(t => ({ ...t, source: project.name })));
  }

  // Add system-level items
  items.push(...await getSystemMaintenanceTasks());
  items.push(...await getStaleFlowRecoveries());

  // Score and sort
  return items
    .map(item => ({ ...item, priority: scorePriority(item) }))
    .sort((a, b) => b.priority - a.priority);
}
```

### Strategy Selection

For the highest-priority item, the system selects an execution strategy:

```javascript
async function selectStrategy(item) {
  // Check if a reflex or known skill handles this
  const fastPath = await matchSkill(item);
  if (fastPath) return { type: 'skill', skill: fastPath };

  // Otherwise, plan with the LLM
  const plan = await deliberate(item, {
    context: await assembleContext(item, 'autonomous'),
    constraint: 'Produce a concrete action plan with at most 3 steps'
  });

  return { type: 'plan', steps: plan.steps };
}
```

### Working Hours Gate

Autonomous actions respect configurable working hours:

```javascript
function isWithinWorkingHours() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  // Weekend: only critical actions
  if (day === 0 || day === 6) return 'critical-only';

  // Weekday working hours
  if (hour >= 9 && hour < 18) return 'full';

  // Off-hours: monitoring and non-disruptive only
  return 'monitoring-only';
}
```

### Autonomy Tiers and Approval Queue

Actions are classified into autonomy tiers that determine whether they execute immediately or queue for approval:

```javascript
const AUTONOMY_TIERS = {
  1: { label: 'observe',  auto: true  },  // Read-only: status checks, monitoring
  2: { label: 'suggest',  auto: true  },  // Internal: memory writes, notes
  3: { label: 'act',      auto: false },  // External: commits, messages, deploys
  4: { label: 'critical', auto: false },  // Destructive: deletes, force operations
};

async function executeAction(action) {
  const tier = AUTONOMY_TIERS[action.tier];

  if (!tier.auto) {
    // Queue for human approval
    await approvalQueue.add({
      action,
      reason: action.rationale,
      groupKey: action.batchGroup  // Group related approvals
    });
    return { status: 'queued', queueId: action.id };
  }

  return await action.execute();
}
```

### Batch Approval

Related actions are grouped so the user can approve them in bulk:

```javascript
async function processApprovalQueue() {
  const groups = approvalQueue.getGrouped();

  for (const [groupKey, actions] of groups) {
    // Present as a batch: "3 code-review actions pending for project X"
    await notify({
      type: 'approval-batch',
      group: groupKey,
      count: actions.length,
      summary: summarizeActions(actions),
      actions: ['approve-all', 'review-each', 'deny-all']
    });
  }
}
```

### Action Buffer and Undo

Recent autonomous actions are buffered to support undo:

```javascript
const actionBuffer = new RingBuffer(50);  // Last 50 actions

async function executeWithUndo(action) {
  const result = await action.execute();

  actionBuffer.push({
    action,
    result,
    timestamp: Date.now(),
    undo: action.buildUndo?.(result)  // Optional undo function
  });

  return result;
}

async function undoLast() {
  const last = actionBuffer.peek();
  if (last?.undo) {
    await last.undo();
    actionBuffer.pop();
  }
}
```

### Autonomy Promotion and Demotion

The system's autonomy level adjusts based on trust signals:

```javascript
function adjustAutonomy(feedback) {
  if (feedback.type === 'user-approved' && feedback.consecutive >= 10) {
    // Promote: user has approved 10 consecutive tier-3 actions
    promoteToAuto(feedback.actionType);
  }

  if (feedback.type === 'user-denied' || feedback.type === 'undo-requested') {
    // Demote: require approval for this action type again
    demoteToQueued(feedback.actionType);
  }
}
```

## Implications

- The cycle introduces continuous compute cost even when idle — rate limiting is essential
- Working hours are timezone-dependent and need configuration per user/team
- Batch approval UX is critical — too many approval requests train users to auto-approve, defeating the purpose
- The undo buffer has limited depth — destructive actions beyond buffer size are unrecoverable
- Autonomy promotion is a ratchet that can grant too much trust if error detection is weak
- Priority scoring determines what the agent focuses on — poor scoring means important work gets delayed
- Concurrent autonomous actions across projects need coordination to avoid resource contention

## Code Example

```javascript
// Main autonomous agent loop
async function agentLoop() {
  while (running) {
    const mode = isWithinWorkingHours();
    if (mode === 'none') {
      await sleep(60_000);
      continue;
    }

    const priorities = await scanPriorities();
    const filtered = priorities.filter(p =>
      mode === 'full' || (mode === 'critical-only' && p.priority > 90)
        || (mode === 'monitoring-only' && p.tier <= 1)
    );

    for (const item of filtered.slice(0, 5)) {  // Max 5 actions per cycle
      const strategy = await selectStrategy(item);
      const action = buildAction(strategy, item);
      await executeAction(action);
    }

    await sleep(30_000);  // 30s between cycles
  }
}
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
