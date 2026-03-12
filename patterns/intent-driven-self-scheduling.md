# Intent-Driven Self-Scheduling

> An agent schedules its own future wake-ups rather than relying on external polling or fixed cron intervals.

## Problem

Traditional scheduling for AI agents uses fixed cron jobs or polling loops — the agent runs every N minutes whether or not there's anything to do. This wastes resources on idle checks, creates unnecessary latency when urgent work appears between intervals, and gives the agent no agency over its own attention rhythm. The agent can't say "check on this deployment in 30 minutes" or "remind me to follow up at 5pm."

## Context

- An orchestrator that needs to perform work at self-determined times, not just in response to external triggers
- Situations where the agent discovers during one task that future attention is needed at a specific time
- Systems that benefit from natural daily rhythms (morning planning, evening wrap-up) alongside ad-hoc intentions
- Agents that should be able to reason about *when* to think, not just *what* to think about

## Solution

### Dual-Layer Scheduling: Anchors + Intentions

The system has two layers of self-scheduling:

**Daily anchors** are hardcoded recurring wake-ups that provide rhythm:

```javascript
const DAILY_ANCHORS = [
  {
    id: 'morning-orientation',
    hour: 9,
    type: 'reflection',
    model: 'sonnet',
    prompt: 'Morning orientation. Review overnight activity, pending tasks, and calendar. Plan the day.',
  },
  {
    id: 'midday-check',
    hour: 13,
    type: 'check',
    model: 'haiku',
    prompt: 'Midday check. Any stale tasks? Stuck satellites? Anything unresolved?',
  },
  {
    id: 'evening-summary',
    hour: 18,
    type: 'reflection',
    model: 'sonnet',
    prompt: 'End of day. Summarize what got done. Set tomorrow\'s intentions.',
  },
];
```

**Ad-hoc intentions** are set by the agent itself during normal operation:

```javascript
function setIntention(when, prompt, type = 'check', model = 'haiku') {
  // Validate against cap (max 10 active intentions)
  // Parse flexible time: "30m", "2h", "5 ticks", ISO datetime
  // Enforce 24-hour horizon (use cron tasks for longer)
  const triggerAt = parseWhen(when);
  intentions.add(triggerStr, type, prompt, model);
  return { ok: true, id, trigger_at: triggerStr };
}
```

### Tick-Based Evaluation

A tick loop (every ~60 seconds) checks for due intentions:

```javascript
function checkDue() {
  const due = intentions.due();
  for (const intent of due) {
    fired.push(intent);
    if (intent.recurring) {
      // Reschedule for tomorrow at the same hour
      intentions.reschedule(intent.id, nextDay);
    } else {
      intentions.remove(intent.id);
    }
  }
  return fired;
}
```

Each fired intention becomes a dispatch to the AI brain with the stored prompt as context.

### Time Parsing

The agent can express time naturally:
- Relative: `"30m"`, `"2h"`, `"90s"`
- Tick-based: `"5 ticks"` (each tick ≈ 1 minute)
- Absolute: ISO datetime strings

### Safety Bounds

- **Cap**: Maximum 10 active intentions prevents runaway self-scheduling
- **Horizon**: 24-hour maximum — longer-term scheduling uses cron tasks instead
- **Crash recovery**: All intentions are database-persisted; surviving a restart means no missed wake-ups

## Implications

- The agent develops a natural daily rhythm through anchors while retaining flexibility via ad-hoc intentions
- Model selection per intention enables cost optimization — lightweight checks use Haiku, deeper reflections use Sonnet
- The 24-hour horizon creates a clean separation: intentions are short-term attention; cron tasks are long-term scheduling
- Without the cap, a reasoning loop could schedule exponentially many future intentions
- Intentions are prompts, not actions — the agent still reasons about what to do when it wakes up
- Tick granularity (~60s) means sub-minute precision isn't possible

## Code Example

```javascript
// During a deployment review, Riley decides to check back later
setIntention('30m', 'Check if the deploy to production completed successfully. Review error logs if not.');

// After a user conversation, schedule follow-up
setIntention('2h', 'User asked about the billing integration. Check if the PR was merged and tests passed.');

// Evening summary sets tomorrow's intentions
setIntention('2025-03-13T09:00:00', 'Follow up on the failed kanban reconciliation from yesterday.');
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Inner Monologue and Reflection](./inner-monologue-and-reflection.md)
