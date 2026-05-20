# Time-Boxed Autonomy Boost

> User-granted temporary elevation of an agent's autonomy level, with auto-expiry, per-boost action quotas, cooldowns between boosts, and named presets for common scenarios.

## Problem

An agent's permanent autonomy setting is a single tradeoff: high autonomy ships work fast but produces unwanted side effects when the user is around to handle things; low autonomy is safe but stalls when the user is unavailable. Neither setting fits a meeting, a flight, or a deep-work block. Toggling autonomy by hand for each window is friction the user will skip — and forgetting to toggle back creates the worst-of-both outcome: elevated autonomy with no time bound.

## Context

- The agent has discrete autonomy levels (1–4) that gate which actions execute, notify, or queue
- The user's availability varies in known windows (meetings, focus blocks, travel, sleep)
- "Full autonomy until I get back" is the natural mental model — bounded by time, not by action count alone
- An always-on elevated setting is unsafe; a manual toggle-back is unreliable
- Multiple concurrent boosts would make the effective autonomy level ambiguous

## Solution

A boost is a database row with a level, an `expires_at` timestamp, an action counter, and an optional preset name. While a boost is active, the agent's effective autonomy level is read from the boost instead of the user's default. When `expires_at` passes (or the action cap is hit, or the user ends it early), the boost ends and the default level resumes.

### Named Presets for Common Scenarios

Presets encode the user's most common windows so the request is one word, not a level-plus-duration calculation:

```javascript
const BOOST_PRESETS = {
  meeting:   { level: 4, duration: 120, description: 'Full autonomy during meetings' },
  focus:     { level: 3, duration: 60,  description: 'Elevated autonomy during focus time' },
  away:      { level: 4, duration: 480, description: 'Handle things while away' },
  quick:     { level: 3, duration: 30,  description: 'Quick burst of autonomy' },
  deep_work: { level: 4, duration: 240, description: 'Full autonomy for deep work session' },
  commute:   { level: 3, duration: 60,  description: 'Handle routine tasks during commute' },
}
```

### Safety Limits

Three limits prevent abuse and runaway behavior:

```javascript
const BOOST_LIMITS = {
  maxDuration: 480,         // 8 hours max — no week-long boosts
  maxLevel: 4,              // never exceed user's hard ceiling
  cooldown: 60,             // 60 min between boosts — prevents toggle-loop abuse
  maxActionsPerBoost: 100,  // auto-end if the agent runs away with itself
}
```

The cooldown is the most non-obvious guard: it stops an agent (or a careless user) from ending a boost and immediately starting another to dodge the duration cap.

### Starting a Boost

`startBoost` validates against the limits, checks for an existing active boost, enforces the cooldown, then inserts a row:

```javascript
async function startBoost({ level, durationMinutes, reason, preset }) {
  if (level < 1 || level > BOOST_LIMITS.maxLevel) throw new Error(...)
  if (durationMinutes > BOOST_LIMITS.maxDuration) throw new Error(...)

  const existing = await getCurrentBoost()
  if (existing) throw new Error(`Boost already active — ${existing.remainingMinutes}m remaining`)

  const lastBoost = await select('autonomy_boosts')
    .where('ended_at IS NOT NULL').orderBy('ended_at', 'DESC').limit(1).one()
  if (lastBoost) {
    const cooldownEnd = new Date(lastBoost.ended_at)
    cooldownEnd.setMinutes(cooldownEnd.getMinutes() + BOOST_LIMITS.cooldown)
    if (new Date() < cooldownEnd) throw new Error(`Cooldown active`)
  }

  const expiresAt = new Date(Date.now() + durationMinutes * 60_000)
  return insert('autonomy_boosts', {
    level, reason, preset,
    started_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
    actions_taken: 0,
  })
}
```

### Effective Level Resolution

Every autonomy check goes through `getEffectiveAutonomyLevel` rather than reading the user's default directly. The boost overrides the default for the duration of the window:

```javascript
async function getEffectiveAutonomyLevel(defaultLevel) {
  const boost = await getCurrentBoost()  // cached, 10s TTL
  if (boost) return boost.level
  return defaultLevel
}
```

The 10-second cache keeps the per-action overhead near-zero while still catching expiry within a tick.

### Action Counting and Auto-End

Each action the agent takes during a boost increments `actions_taken`. If the counter hits `maxActionsPerBoost`, the boost ends automatically with a system note. This catches "agent in a loop" failures before they consume the whole window:

```javascript
async function recordBoostAction(boostId) {
  const updated = await update('autonomy_boosts',
    { actions_taken: raw('actions_taken + 1') }, 'id = ?', boostId)
  if (updated.actions_taken >= BOOST_LIMITS.maxActionsPerBoost) {
    await endBoost(boostId, { reason: 'action_cap_reached' })
  }
}
```

### Query Output: Progress Fields

`getCurrentBoost` returns not just the row but derived fields the UI can render directly — remaining minutes, total minutes, progress %, actions remaining. The agent and dashboard render the same shape without re-computing:

```javascript
{
  id, level, reason, preset,
  startedAt, expiresAt,
  remainingMinutes, remainingMs, totalMinutes,
  progress,         // 0-100
  actionsTaken, actionsRemaining,
}
```

## Implications

- **Time-bound by default** — the user can't accidentally leave the agent elevated; expiry is mandatory at creation
- **One boost at a time** — concurrent boosts would make the effective level ambiguous; the system rejects a second start while one is active
- **Cooldown blocks the dodge** — without it, a malicious or buggy caller could end-then-restart to evade `maxDuration`
- **Action cap catches loops** — even within the time window, a runaway agent stops at 100 actions instead of burning the whole boost
- **Cache TTL determines snap-back latency** — a 10s cache means an expired boost may still report active for up to 10s; tuneable per cost-of-stale tolerance
- **Presets reduce the user's input to one word** — `boost meeting` vs. `boost --level 4 --duration 120`; presets are also self-documenting for the agent's UI

## Code Example

```javascript
const autonomy = require('./lib/agent/autonomy-boost')

// User: "Going into a 2-hour design review, take care of things"
await autonomy.startBoost(autonomy.BOOST_PRESETS.meeting)
// → level 4 for 120 minutes

// Every autonomous action checks the effective level
const level = await autonomy.getEffectiveAutonomyLevel(user.defaultAutonomyLevel)
if (level >= TIER_OF(action)) {
  await executeAction(action)
  await autonomy.recordBoostAction(currentBoost.id)
}

// Dashboard polls every 10s — fresh derived fields each call
const boost = await autonomy.getCurrentBoost()
// { remainingMinutes: 47, progress: 60, actionsTaken: 12, actionsRemaining: 88, ... }

// User comes back early
await autonomy.endBoost(boost.id, { reason: 'user_returned' })
// → cooldown starts; next boost can't begin for 60 minutes
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Autonomy Rule Suggestion](./autonomy-rule-suggestion.md)
- [Situation Detection and Context Awareness](./situation-detection-and-context-awareness.md)
