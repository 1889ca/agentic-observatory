# Deliberative Alignment

> Value-action comparison ensuring agent behavior aligns with stated preferences through pre-execution conflict detection.

## Problem

An autonomous agent that acts on user intent without checking against user preferences will eventually violate boundaries the user assumed were obvious. A scheduling agent sends a notification at 3am. A coding agent force-pushes to main. A messaging agent shares a private draft with a public channel. These aren't capability failures — the agent has the skill to do what was asked. They're alignment failures — the agent didn't check whether the action conflicted with the user's values, preferences, or rules. The more autonomous an agent becomes, the more critical this pre-flight check is.

## Context

- An agent that takes real-world actions (sends messages, modifies files, makes API calls)
- A user or organization with stated preferences, rules, or constraints
- Preferences that may be implicit, contextual, or time-dependent
- Actions that vary in reversibility and impact severity
- A need for the agent to flag conflicts rather than silently comply or silently refuse

## Solution

### Preference Store

Preferences are stored as structured rules with conditions, not just flat text. Each preference has a scope, priority, and optional temporal constraint:

```javascript
const preferenceStore = {
  async load(tenantId) {
    const prefs = await db.preferences.findMany({
      where: { tenantId, enabled: true },
      orderBy: { priority: 'desc' }
    });

    return prefs.map(p => ({
      id: p.id,
      rule: p.rule,
      scope: p.scope,           // 'global' | 'channel' | 'tool'
      condition: p.condition,    // optional JS predicate string
      priority: p.priority,      // higher = harder to override
      temporal: p.temporal,      // { after: '22:00', before: '08:00', tz: 'America/New_York' }
      resolution: p.resolution   // 'block' | 'modify' | 'escalate' | 'warn'
    }));
  }
};
```

### Action Proposal

Before execution, every action is wrapped in a proposal object that describes what the agent intends to do:

```javascript
function createProposal(action) {
  return {
    id: crypto.randomUUID(),
    tool: action.tool,
    params: action.params,
    intent: action.intent,
    timestamp: Date.now(),
    metadata: {
      channel: action.channel,
      recipients: action.recipients || [],
      reversible: action.reversible ?? true,
      impact: estimateImpact(action)
    }
  };
}

function estimateImpact(action) {
  const irreversibleTools = ['git_push_force', 'delete_production', 'send_email'];
  const broadcastTools = ['send_channel_message', 'deploy', 'publish'];

  if (irreversibleTools.includes(action.tool)) return 'critical';
  if (broadcastTools.includes(action.tool)) return 'high';
  return 'standard';
}
```

### Conflict Detection

The alignment engine compares each proposal against all applicable preferences, evaluating both static rules and temporal conditions:

```javascript
async function detectConflicts(proposal, preferences) {
  const conflicts = [];

  for (const pref of preferences) {
    // Scope filtering — skip preferences that don't apply
    if (pref.scope === 'tool' && !pref.rule.includes(proposal.tool)) continue;
    if (pref.scope === 'channel' && pref.channel !== proposal.metadata.channel) continue;

    // Temporal check
    if (pref.temporal && isWithinTimeWindow(pref.temporal)) {
      const violation = evaluateTemporalRule(proposal, pref);
      if (violation) {
        conflicts.push({
          preference: pref,
          type: 'temporal',
          message: violation.message,
          resolution: pref.resolution
        });
      }
    }

    // Semantic check — use LLM to evaluate natural-language rules
    if (pref.condition) {
      const result = await evaluateCondition(pref.condition, proposal);
      if (result.violated) {
        conflicts.push({
          preference: pref,
          type: 'semantic',
          message: result.explanation,
          resolution: pref.resolution
        });
      }
    }
  }

  return conflicts;
}

function isWithinTimeWindow(temporal) {
  const now = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: temporal.tz
  });
  return now >= temporal.after || now <= temporal.before;
}
```

### Resolution Strategies

When conflicts are detected, the system applies the resolution strategy specified by the preference:

```javascript
async function resolveConflicts(proposal, conflicts) {
  if (conflicts.length === 0) return { action: 'proceed', proposal };

  // Sort by preference priority — highest priority conflict wins
  conflicts.sort((a, b) => b.preference.priority - a.preference.priority);
  const primary = conflicts[0];

  switch (primary.resolution) {
    case 'block':
      return {
        action: 'blocked',
        reason: primary.message,
        conflicts
      };

    case 'modify':
      const modified = await suggestModification(proposal, primary);
      return {
        action: 'modified',
        original: proposal,
        proposal: modified,
        reason: primary.message
      };

    case 'escalate':
      return {
        action: 'escalated',
        proposal,
        conflicts,
        approvalRequired: true
      };

    case 'warn':
      return {
        action: 'proceed_with_warning',
        proposal,
        warnings: conflicts.map(c => c.message)
      };
  }
}

async function suggestModification(proposal, conflict) {
  // Example: reschedule a message to an acceptable time
  if (conflict.type === 'temporal') {
    const nextWindow = computeNextAllowedWindow(conflict.preference.temporal);
    return {
      ...proposal,
      params: { ...proposal.params, scheduledAt: nextWindow },
      modified: true,
      modificationReason: conflict.message
    };
  }

  // Fallback: ask LLM for a modified version
  return await llm.complete({
    system: 'Modify this action to satisfy the constraint without losing the user intent.',
    messages: [{ role: 'user', content: JSON.stringify({ proposal, conflict }) }]
  });
}
```

### Integration Point

The alignment check sits between intent resolution and execution in the agent's main loop:

```javascript
async function executeWithAlignment(action, tenantId) {
  const proposal = createProposal(action);
  const preferences = await preferenceStore.load(tenantId);
  const conflicts = await detectConflicts(proposal, preferences);
  const resolution = await resolveConflicts(proposal, conflicts);

  switch (resolution.action) {
    case 'proceed':
    case 'proceed_with_warning':
      return await executeTool(resolution.proposal);

    case 'modified':
      return await executeTool(resolution.proposal);

    case 'blocked':
      return { status: 'blocked', reason: resolution.reason };

    case 'escalated':
      return await requestHumanApproval(resolution);
  }
}
```

## Implications

- Semantic conflict detection requires an LLM call per preference per action — batching helps but adds latency
- Natural-language preferences are inherently ambiguous; the system will produce both false positives and false negatives
- Temporal rules depend on accurate timezone handling and clock synchronization
- The "modify" resolution strategy may alter user intent in unexpected ways — always surface modifications
- Preference priority ordering is critical; conflicting preferences without clear priority cause unpredictable behavior
- This pattern works best with a small, curated set of high-signal preferences rather than an exhaustive rule list

## Code Example

```javascript
// Preference definition examples
const preferences = [
  {
    id: 'quiet-hours',
    rule: 'No notifications between 10pm and 8am',
    scope: 'global',
    temporal: { after: '22:00', before: '08:00', tz: 'America/New_York' },
    priority: 90,
    resolution: 'modify'  // reschedule, don't block
  },
  {
    id: 'no-force-push',
    rule: 'Never force-push to main or production branches',
    scope: 'tool',
    condition: 'action.tool === "git_push" && action.params.force && ["main", "production"].includes(action.params.branch)',
    priority: 100,
    resolution: 'block'
  },
  {
    id: 'draft-review',
    rule: 'External-facing content must be reviewed before sending',
    scope: 'channel',
    condition: 'action.metadata.recipients.some(r => r.external)',
    priority: 80,
    resolution: 'escalate'
  }
];
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Inner Monologue and Reflection](./inner-monologue-and-reflection.md)
