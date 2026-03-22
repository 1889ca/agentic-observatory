# Autonomy Boost and Approval Learning

> Time-boxed autonomy boost presets that grant temporary elevated permissions for a specified duration, replacing approval-pattern learning with explicit user-controlled trust windows.

## Problem

Agent systems that require approval for every action create friction that defeats the purpose of automation. But removing approvals entirely is dangerous. Users need a way to say "I trust you for the next couple hours while I'm watching" without permanently lowering safety guardrails. Learning from approval history is appealing in theory, but in practice it's brittle — user intent changes, contexts shift, and a pattern of approvals in one situation doesn't generalize to another.

## Context

- An agent system with human-in-the-loop approval for tool execution
- Users have work sessions where they want reduced friction for a known period
- Permanent autonomy changes are risky — users want temporary trust windows
- The boost should expire automatically without requiring the user to remember to revoke it
- Different situations call for different boost durations

## Solution

### Time-Boxed Boost Presets

Instead of learning from approval patterns, the system offers explicit boost presets. The user grants a temporary autonomy boost for a specific duration — the system operates with elevated permissions until the timer expires:

```javascript
// autonomy/boost.js
const activeBoosts = new Map();

function grantBoost(tenantId, preset) {
  const durations = {
    short: 2 * 60 * 60 * 1000,   // 2 hours
    long: 4 * 60 * 60 * 1000,    // 4 hours
  };

  const duration = durations[preset] || durations.short;
  const boost = {
    tenantId,
    preset,
    grantedAt: Date.now(),
    expiresAt: Date.now() + duration,
  };

  activeBoosts.set(tenantId, boost);
  return boost;
}
```

### Boost Checking

Before requesting approval for an action, the system checks whether an active boost exists. If boosted, actions that would normally require approval are auto-executed:

```javascript
function isBoosted(tenantId) {
  const boost = activeBoosts.get(tenantId);
  if (!boost) return false;

  if (Date.now() > boost.expiresAt) {
    activeBoosts.delete(tenantId);
    return false;
  }

  return true;
}

async function executeWithApproval(tool, args, context) {
  if (isBoosted(context.tenantId)) {
    context.notify(`Boost active: auto-executing ${tool.name}`);
    return tool.execute(args);
  }

  const approved = await context.requestApproval({ tool: tool.name, args });
  if (!approved) return { rejected: true };
  return tool.execute(args);
}
```

### Boost Revocation

Users can manually revoke a boost at any time. Boosts also self-expire when the duration elapses:

```javascript
function revokeBoost(tenantId) {
  activeBoosts.delete(tenantId);
}

function getBoostStatus(tenantId) {
  const boost = activeBoosts.get(tenantId);
  if (!boost) return { active: false };

  const remaining = boost.expiresAt - Date.now();
  if (remaining <= 0) {
    activeBoosts.delete(tenantId);
    return { active: false };
  }

  return {
    active: true,
    preset: boost.preset,
    remainingMs: remaining,
  };
}
```

## Implications

- Time-boxed boosts are explicit and predictable — users know exactly when elevated autonomy expires
- No learning complexity — the system doesn't need to track approval history, fingerprint actions, or maintain consecutive counters
- Boost expiry is automatic, eliminating the risk of permanently elevated permissions from forgotten settings
- The preset model (2h/4h) is simple but inflexible — users can't specify arbitrary durations without extending the presets
- Boosts apply to all actions equally during the window — there's no per-action granularity during a boost
- Boost state is in-memory, so process restarts clear active boosts (fail-safe: permissions drop to default)
- This pattern is complementary to domain confidence — confidence provides long-term earned trust, boosts provide short-term explicit trust

## Code Example

```javascript
// User grants a 2-hour boost via chat
// "Give yourself a boost for a couple hours"
const boost = grantBoost(tenantId, 'short');
// → { preset: 'short', expiresAt: <now + 2h> }

// During the boost window, actions auto-execute
// User: "run the tests and deploy if they pass"
// Agent: Boost active: auto-executing run_tests
// Agent: Boost active: auto-executing deploy
// (no approval prompts)

// After 2 hours, boost expires automatically
// User: "deploy to staging"
// Agent: [Requesting approval] Deploy to staging?
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Implicit Approval Parsing](./implicit-approval-parsing.md)
