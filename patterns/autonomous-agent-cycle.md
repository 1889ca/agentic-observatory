# Autonomous Agent Cycle

> Periodic autonomous thinking loop running every 30 minutes during work hours (weekdays 9 AM - 6 PM) that reflects on current state, identifies actions, executes low-risk ones automatically, and queues high-risk ones for user approval. Currently disabled and consolidated into a semantic job group.

## Problem

An AI orchestrator that only responds to user messages is reactive — it waits idle between interactions. But a capable system should proactively pursue objectives, identify potential actions, and execute routine work without being asked. A continuous loop wastes compute when idle. A fast tick-based event processor is overkill for autonomous planning. What's needed is a periodic cycle that checks in on current state and generates work from it, with gating to ensure it only acts within acceptable autonomy bounds.

## Context

- An orchestrator with access to todos, goals, projects, emails, and external services
- Autonomous actions need human approval for high-risk operations
- The cycle must not interfere with interactive user requests
- Autonomy is configurable — the job checks an autonomy tier before running
- The cycle was originally a standalone job but has been consolidated into a broader semantic job group for operational simplicity

## Solution

### Schedule and Gating

The autonomous agent cycle is configured with a cron schedule of `*/30 9-18 * * 1-5` — every 30 minutes during business hours on weekdays. Before any work happens, the job checks the system's autonomy settings to verify it has permission to run:

```javascript
// jobs/autonomous-agent.js
module.exports = {
  name: 'autonomous-agent',
  description: 'Autonomous thinking cycle (every 30 min, work hours weekdays)',
  schedule: schedules.SCHEDULES.AUTONOMOUS_AGENT,  // */30 9-18 * * 1-5
  autonomyLevel: 'NOTIFY',
  enabled: false,  // Consolidated into proactive-intelligence.js
  run,
};

async function run() {
  return audit.trackJob('autonomous-agent', async () => {
    const autonomyCheck = await canJobRun('autonomous-agent');
    if (!autonomyCheck.allowed) {
      await orchestrator.logAction({
        actor: 'job:autonomous-agent',
        actionType: 'skip',
        description: `Skipped autonomous cycle: ${autonomyCheck.reason}`,
      });
      return;
    }
    // ... cycle logic
  });
}
```

### Cycle Execution

Each cycle invokes the agent's autonomous reasoning loop, which reflects on the current state (todos, goals, projects, emails) and produces two categories of actions:

```javascript
const agent = require('../lib/agent');

const result = await agent.runAutonomousCycle();

// result.executed — low-risk actions already performed
// result.queued — high-risk actions awaiting user approval
```

### Action Classification and Logging

Executed and queued actions are logged through the orchestrator for full audit trail visibility. Each action records its type, reasoning, and whether the user should see it:

```javascript
for (const action of result.executed || []) {
  await orchestrator.logAction({
    actor: 'job:autonomous-agent',
    actionType: 'auto_execute',
    actionSubtype: action.action_type,
    description: action.description || `Executed: ${action.action_type}`,
    decisionReason: action.reasoning,
    userVisible: action.tier === 'notify',
  });
}
```

### Pending Approval Notification

When actions are queued for approval, the cycle creates an attention item and notifies the user through the messenger. This bridges the gap between autonomous operation and human oversight:

```javascript
const pending = await agent.getPendingApprovals();
if (pending.length > 0) {
  await orchestrator.createAttentionItem({
    domain: 'task',
    itemType: 'pending_approval',
    title: `${pending.length} autonomous action(s) need approval`,
    description: pending.slice(0, 3).map(a => a.description).join('; '),
    priority: 2,
    urgency: 'normal',
    sourceType: 'autonomous_actions',
    metadata: {
      count: pending.length,
      actions: pending.slice(0, 5).map(a => ({
        id: a.id, type: a.action_type, description: a.description,
      })),
    },
  });

  await jobMessenger.text(
    `*Autonomous Agent*\n\n` +
    `I have ${pending.length} action(s) waiting for your approval:\n` +
    pending.slice(0, 3).map(a => `- ${a.description}`).join('\n') +
    (pending.length > 3 ? `\n...and ${pending.length - 3} more` : '') +
    `\n\nSay "show pending actions" to review.`
  );
}
```

### Consolidation into Semantic Job Group

The standalone autonomous agent job is disabled (`enabled: false`) and its functionality has been consolidated into `proactive-intelligence.js`, a semantic job group that bundles related proactive behaviors. This reduces the number of scheduled jobs while maintaining the same autonomous capabilities:

```javascript
// The job module still exists for documentation and potential re-enablement
module.exports = {
  enabled: false,  // Consolidated into semantic job group jobs/proactive-intelligence.js
  // ...
};
```

## Implications

- The 30-minute interval (not 2-hour) balances responsiveness with compute cost — autonomous actions surface within half an hour during business hours
- Autonomy gating (`canJobRun`) means the cycle does nothing unless the system's autonomy level permits it — this is configurable at runtime
- The separation between `executed` (low-risk, auto-performed) and `queued` (high-risk, awaiting approval) actions creates a clear trust boundary
- Attention items and messenger notifications ensure queued actions are visible even if the user isn't actively looking at the dashboard
- Consolidation into a semantic job group means the autonomous cycle shares scheduling infrastructure with related proactive behaviors (suggestions, follow-ups, etc.)
- The disabled-but-present pattern allows the job to be re-enabled for debugging or if the semantic group approach is reversed
- All actions flow through the orchestrator's audit trail, making autonomous behavior fully traceable

## Code Example

```javascript
// Typical cycle execution flow:

// 1. Job fires at 10:30 AM on a Tuesday
// 2. Autonomy check passes (user has autonomy set to NOTIFY)
// 3. Agent reflects on current state:
//    - 3 overdue tasks found
//    - Email from client needs follow-up
//    - GitHub PR has been open for 3 days
// 4. Low-risk actions executed automatically:
//    - Sent reminder about overdue tasks
//    - Updated task priorities based on deadlines
// 5. High-risk actions queued for approval:
//    - "Send follow-up email to client about project timeline"
//    - "Post review comment on stale PR"
// 6. User notified: "I have 2 action(s) waiting for your approval"
// 7. User responds "yes" → actions execute via implicit approval parsing
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Implicit Approval Parsing](./implicit-approval-parsing.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
