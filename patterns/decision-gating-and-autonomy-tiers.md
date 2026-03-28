# Decision Gating and Autonomy Tiers

> User-defined conditional rule engine that elevates or restricts tool autonomy tiers based on pattern matching against action context, layered on top of the static tier system.

## Problem

Static tool tiers are a good default, but users develop trust patterns that don't fit a single tier assignment. A user might want "auto-archive all emails from no-reply@ addresses" (elevating an ASK-tier action to AUTO for a specific sender pattern) or "always ask before touching the billing-api repo" (restricting a NOTIFY-tier action to ASK for a specific repo). Without user-defined rules, the system either requires manual overrides for every recurring exception or forces the user to change the global autonomy level, which is too coarse.

## Context

- A static tool tier system (AUTO/NOTIFY/ASK/NEVER) that handles the common case
- Users who develop predictable patterns of approval and rejection
- Actions that carry context (sender, repo, event type, tool name, project)
- Need for rules that are auditable, reversible, and cacheable
- Rules that can both elevate (grant more autonomy) and restrict (require more caution)

## Solution

### Conditional Rule Engine

`lib/agent/autonomy-rules.js` implements a rule engine where each rule has a set of conditions and a granted tier. When an action matches a rule's conditions, the rule's tier overrides the default. Rules use AND logic: all specified conditions must match for the rule to fire.

```javascript
// lib/agent/autonomy-rules.js

// Rule schema (stored in autonomy_rules table):
// {
//   name: "Auto-archive newsletters",
//   conditions: { type: "email", sender_pattern: "no-reply@*" },
//   granted_tier: "AUTO",
//   direction: "elevate",  // or "restrict"
//   enabled: true,
// }
```

### Condition Types

Rules support multiple condition domains, each with its own matching fields:

```javascript
// Email conditions
{ sender_pattern: "no-reply@*", subject_pattern: "*invoice*", label: "newsletters" }

// GitHub conditions
{ repo: "owner/billing-api", event_type: "assigned", author: "dependabot*" }

// Task conditions
{ source: "scheduled", project_pattern: "billing*" }

// Generic conditions (work for any action)
{ action_type: "deploy", target_pattern: "production*", tool_name: "send_email" }
```

Patterns support wildcards: `*` matches any characters, `?` matches a single character. Matching is case-insensitive.

### Pattern Matching

Each action carries a context object. The rule engine checks every condition in the rule against the action context. All conditions must match (AND logic):

```javascript
function matchesSingleRule(action, rule) {
  const conditions = rule.conditions || {};

  for (const [key, value] of Object.entries(conditions)) {
    if (value === null || value === undefined) continue;

    switch (key) {
      case 'sender_pattern':
        if (!matchesPattern(value, action.email?.sender || action.sender))
          return false;
        break;

      case 'repo':
        if (!matchesPattern(value, action.github?.repo || action.repo))
          return false;
        break;

      case 'tool_name':
        if (!matchesPattern(value, action.toolName || action.tool))
          return false;
        break;

      // ... 12+ condition types covering email, GitHub, task, generic
    }
  }
  return true;  // All conditions matched
}
```

### Tier Elevation and Restriction

Rules have a `direction` field that controls whether they make things more permissive (elevate) or more cautious (restrict):

```javascript
async function getEffectiveTier(action, defaultTier) {
  const rules = await getEnabledRules();
  const matchingRule = await matchesRule(action, rules);

  if (matchingRule) {
    const grantedTier = tierToNumber(matchingRule.granted_tier);

    if (matchingRule.direction === 'restrict') {
      // Only apply if MORE restrictive (higher number)
      if (grantedTier > defaultTier) {
        return { tier: grantedTier, rule: matchingRule, restricted: true };
      }
    } else {
      // Only apply if MORE permissive (lower number)
      if (grantedTier < defaultTier) {
        return { tier: grantedTier, rule: matchingRule, elevated: true };
      }
    }
  }

  return { tier: defaultTier, rule: null, elevated: false };
}
```

This means an elevating rule can only make things less restrictive, and a restricting rule can only make things more restrictive. A rule cannot accidentally do the opposite of its declared intent.

### Integration with Tool Tier System

The autonomy rules layer sits between the static tier lookup and the confidence decision engine. `canExecuteToolWithRules()` in `lib/tools/tiers.js` checks for rule overrides before applying autonomy-level logic:

```javascript
// lib/tools/tiers.js
async function canExecuteToolWithRules(toolName, autonomyLevel, context) {
  const baseTier = getToolTier(toolName);

  // NEVER tier cannot be elevated by rules (safety boundary)
  if (baseTier === APPROVAL_TIERS.NEVER) {
    return { canExecute: false, requiresConfirmation: true };
  }

  // Check for rule-based tier override
  const effective = await autonomyRules.getEffectiveTier(
    { toolName, tool: toolName, ...context },
    baseTier
  );

  // Apply standard autonomy-level logic using the effective tier
  // autonomy 4: everything except NEVER
  // autonomy 3: AUTO + NOTIFY + ASK
  // autonomy 2: AUTO + NOTIFY
  // autonomy 1: AUTO only
  return applyAutonomyLogic(effective.tier, autonomyLevel, effective);
}
```

### Caching and Performance

Rules are cached per-tenant with a 30-second TTL. The cache is invalidated on any CRUD operation:

```javascript
const CACHE_TTL_MS = 30000;
const rulesCache = new Map(); // tenantId -> { rules, expiry }

async function getEnabledRules() {
  const cached = rulesCache.get(tenantId);
  if (cached && Date.now() < cached.expiry) return cached.rules;

  const rules = await select('autonomy_rules')
    .where('enabled = ?', true)
    .orderBy('created_at', 'ASC')
    .all();

  rulesCache.set(tenantId, { rules: parsedRules, expiry: Date.now() + CACHE_TTL_MS });
  return parsedRules;
}

function invalidateCache(tenantId) {
  rulesCache.delete(tenantId);
}
```

### Usage Tracking

Each time a rule fires, it increments a usage counter and updates its last-used timestamp:

```javascript
async function recordRuleUsage(ruleId, actionId) {
  await update('autonomy_rules', {
    used_count: { $raw: 'used_count + 1' },
    last_used_at: new Date().toISOString(),
  }, 'id = ?', ruleId);
}
```

### Seed Defaults

The system ships with disabled default rules that users can enable:

```javascript
const defaults = [
  {
    name: 'Auto-archive newsletters',
    conditions: { type: 'email', sender_pattern: 'no-reply@*' },
    granted_tier: 'AUTO',
    enabled: false,
  },
  {
    name: 'Auto-create tasks from GitHub assignments',
    conditions: { type: 'github', event_type: 'assigned' },
    granted_tier: 'AUTO',
    enabled: false,
  },
  // ...
];
```

## Implications

- Rules use first-match semantics: the first matching rule wins. Rule ordering is by `created_at ASC`, meaning older rules have priority
- NEVER tier is exempt from rule elevation: even if a rule grants AUTO to a NEVER-tier tool, the safety boundary in `canExecuteToolWithRules()` blocks it before rules are consulted
- Direction enforcement prevents accidental misconfiguration: an "elevate" rule that specifies a more restrictive tier than the default is silently ignored (returns the default tier)
- AND logic means rules get more specific as conditions are added: a rule with 3 conditions is harder to trigger than one with 1 condition
- 30-second cache TTL means rule changes take up to 30 seconds to take effect, but CRUD operations invalidate immediately for the modifying tenant
- Wildcard pattern matching converts to regex at match time, not at rule creation time, so patterns are human-readable in the database
- Usage tracking enables stale rule detection: rules with `used_count = 0` and `created_at` older than 30 days are candidates for cleanup

## Code Example

```javascript
// User creates a rule: "Auto-archive all notification emails"
await autonomyRules.createRule({
  name: 'Auto-archive notifications',
  conditions: { type: 'email', sender_pattern: 'notifications@*' },
  granted_tier: 'AUTO',
  direction: 'elevate',
});

// Action arrives: archive email from notifications@github.com
const action = {
  toolName: 'archive_email',
  type: 'email',
  email: { sender: 'notifications@github.com' },
};

// Static tier for archive_email: ASK (3)
// Rule matches: sender_pattern 'notifications@*' matches 'notifications@github.com'
// Rule grants: AUTO (1)
// Direction: elevate, and 1 < 3, so elevation applies
const effective = await getEffectiveTier(action, 3);
// { tier: 1, rule: { name: 'Auto-archive notifications' }, elevated: true }

// Now: archive_email executes as AUTO instead of requiring approval
```

## Related Patterns

- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Worker Permission Escalation](./satellite-permission-escalation.md)
- [Deliberative Alignment](./deliberative-alignment.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
