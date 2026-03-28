# Autonomy Rule Suggestion

> Action-driven rule generation that creates autonomy rules from individually approved actions using pattern-based condition extraction, scope validation, and explicit single-action approval — no statistical pattern detection or aggregated analysis.

## Problem

Configuring an AI agent's autonomy is tedious. Users must manually define rules like "auto-archive emails from noreply@github.com" or "always ask before closing GitHub issues." Most users don't know what rules they need until they've been interrupted by approval requests dozens of times. The ideal system would let users say "always allow this type" when approving an action, and generate the appropriate rule automatically.

## Context

- An AI agent with autonomy tiers (AUTO/NOTIFY/ASK/NEVER) that gate different actions
- Users approve or deny actions one at a time through the UI
- When approving, users can check "Always allow this type" to trigger rule generation
- The system has access to the specific approved action with its full metadata
- Generated rules must be human-readable, editable, and safe by default
- Rules are stored as first-class autonomy rules that gate future actions

## Solution

### Pattern-Based Condition Extraction

Rather than analyzing historical patterns statistically, the auto-rule generator works from a single approved action. It uses a pattern registry keyed by action type to extract appropriate rule conditions:

```javascript
// lib/agent/auto-rule-generator/patterns.js
const RULE_PATTERNS = {
  'email.archive': (action) => {
    const sender = action.parameters?.sender || action.parameters?.from
    if (!sender) return null

    // Notification addresses → use domain pattern
    if (sender.match(/^(no-?reply|notifications?|alerts?)@/i)) {
      const domain = sender.split('@')[1]
      return {
        conditions: { type: 'email', action_type: 'archive', sender_pattern: `*@${domain}` },
        suggestedTier: 'AUTO',
      }
    }
    // Specific sender
    return {
      conditions: { type: 'email', action_type: 'archive', sender_pattern: sender },
      suggestedTier: 'AUTO',
    }
  },

  'github.close_issue': (action) => {
    const repo = action.parameters?.repo
    if (!repo) return null
    return {
      conditions: { type: 'github', event_type: 'close_issue', repo },
      suggestedTier: 'NOTIFY',
    }
  },

  'github.merge_pr': (action) => {
    const repo = action.parameters?.repo
    if (!repo) return null
    return {
      conditions: { type: 'github', event_type: 'merge_pr', repo },
      suggestedTier: 'NOTIFY',
    }
  },

  // Generic tool call fallback
  tool_call: (action) => {
    const toolName = action.parameters?.toolName
    if (!toolName) return null

    // Reject overly broad tools
    if (toolName === 'search' || toolName === 'navigate') return null

    return {
      conditions: { tool_name: toolName },
      suggestedTier: 'NOTIFY',
    }
  },
}
```

The pattern registry covers email actions (archive, label, delete), GitHub actions (close issue, merge PR, create issue), task/document/calendar actions, and a generic `tool_call` fallback.

### Pattern Key Extraction

A `getPatternKey()` function derives the lookup key from an action's metadata, handling nested tool calls and domain-specific routing:

```javascript
// lib/agent/auto-rule-generator/extraction.js
function getPatternKey(action) {
  const actionType = action.actionType || action.action_type

  if (actionType === 'tool_call') {
    const toolName = action.parameters?.toolName
    const toolArgs = action.parameters?.toolArgs || {}

    // Map known tools to specific patterns
    if (toolName === 'entity' && toolArgs.entityType && toolArgs.action) {
      return `${toolArgs.entityType}.${toolArgs.action}`
    }
    if (toolName === 'send_email' || toolName === 'archive_email') {
      return `email.${toolName.replace('_email', '')}`
    }
    if (toolName?.startsWith('github_')) {
      return `github.${toolName.replace('github_', '')}`
    }
    return 'tool_call'
  }

  if (actionType === 'email') return `email.${action.parameters?.action || 'unknown'}`
  if (actionType === 'github') return `github.${action.parameters?.action || 'unknown'}`
  return actionType || 'unknown'
}

function generateRuleFromAction(action) {
  const patternKey = getPatternKey(action)
  let patternFn = RULE_PATTERNS[patternKey]

  // Fall back to generic tool_call pattern
  if (!patternFn && action.actionType === 'tool_call') {
    patternFn = RULE_PATTERNS.tool_call
  }

  if (!patternFn) return null

  const result = patternFn(action)
  return result ? {
    conditions: result.conditions,
    suggestedTier: result.suggestedTier || 'NOTIFY',
    patternKey,
  } : null
}
```

### Safety Guardrails

Two layers of safety prevent dangerous or overly broad rules:

**1. Dangerous action blocking** — Certain tools are never eligible for rule creation:

```javascript
// lib/agent/auto-rule-generator/validation.js
function isSafeForRuleCreation(action) {
  const toolName = action.parameters?.toolName

  const dangerousTools = [
    'delete_file', 'delete_document', 'delete_permanently',
    'send_money', 'transfer_funds', 'execute_code', 'run_command',
  ]

  if (toolName && dangerousTools.some((t) => toolName.toLowerCase().includes(t))) {
    return { safe: false, reason: `Cannot create automatic rules for dangerous operations like ${toolName}` }
  }

  // NEVER tier actions are never eligible
  if (action.approvalTier === 4 || action.approval_tier === 4) {
    return { safe: false, reason: 'Cannot create rules for permanently blocked actions (NEVER tier)' }
  }

  return { safe: true }
}
```

**2. Scope validation** — Rules are checked against recent action history to detect overly broad conditions:

```javascript
// lib/agent/auto-rule-generator/validation.js
async function validateRuleScope(conditions, threshold = 100) {
  // Query autonomous_actions from last 30 days matching these conditions
  // If match count > threshold, warn that the rule is too broad
  const matchCount = await countMatchingActions(conditions)

  if (matchCount > threshold) {
    return {
      valid: false,
      matchCount,
      warning: `This rule would match ${matchCount} recent actions (threshold: ${threshold}). Consider more specific conditions.`,
    }
  }

  return { valid: true, matchCount }
}
```

### Human-Readable Name and Description Generation

Suggested names and descriptions are derived from the conditions and pattern key, not from LLM generation:

```javascript
// lib/agent/auto-rule-generator/suggestions.js
function suggestRuleName(action, ruleData) {
  const parts = []
  const tierVerb = ruleData?.suggestedTier === 'AUTO' ? 'Auto' :
    ruleData?.suggestedTier === 'NOTIFY' ? 'Notify on' : 'Allow'
  parts.push(tierVerb)

  if (ruleData.patternKey.includes('.')) {
    const [type, subAction] = ruleData.patternKey.split('.')
    parts.push(subAction, type)
  } else {
    parts.push(ruleData.patternKey)
  }

  if (ruleData.conditions.sender_pattern) {
    const sender = ruleData.conditions.sender_pattern
    parts.push(sender.startsWith('*@') ? `from ${sender.slice(2)}` : `from ${sender}`)
  } else if (ruleData.conditions.repo) {
    parts.push(`in ${ruleData.conditions.repo}`)
  }

  return parts.join(' ')
}

// Example outputs:
// "Auto archive email from github.com"
// "Notify on close_issue github in my-org/my-repo"
// "Allow create task"
```

### Rule Creation Orchestrator

The `createRuleSuggestion()` function orchestrates the full flow: safety check, pattern extraction, scope validation, name/description generation, and tier enforcement:

```javascript
// lib/agent/auto-rule-generator/creation.js
async function createRuleSuggestion(action, options = {}) {
  // 1. Safety check
  const safety = isSafeForRuleCreation(action)
  if (!safety.safe) return { canCreate: false, reason: safety.reason }

  // 2. Generate rule data from action
  const ruleData = generateRuleFromAction(action)
  if (!ruleData) return { canCreate: false, reason: 'Could not determine conditions for this action type' }

  // 3. Validate scope
  const scopeCheck = await validateRuleScope(ruleData.conditions)

  // 4. Build rule
  const name = options.customName || suggestRuleName(action, ruleData)
  const description = suggestRuleDescription(action, ruleData)
  const tier = options.customTier?.toUpperCase() || ruleData.suggestedTier

  // Safety: default to NOTIFY for auto-generated rules
  const safeTier = tier === 'AUTO' && !options.customTier ? 'NOTIFY' : tier

  return {
    canCreate: true,
    rule: { name, description, conditions: ruleData.conditions, granted_tier: safeTier },
    warning: scopeCheck.valid ? undefined : scopeCheck.warning,
    suggestedTier: ruleData.suggestedTier,
    matchCount: scopeCheck.matchCount,
  }
}
```

### Default-to-NOTIFY Safety Net

The most important safety feature: auto-generated rules default to NOTIFY tier even when the pattern suggests AUTO. Only when the user explicitly upgrades the tier does a rule grant full autonomy:

```javascript
const safeTier = tier === 'AUTO' && !options.customTier ? 'NOTIFY' : tier
```

This means the system will execute the action and notify the user, but won't silently auto-approve until the user consciously opts in.

## Implications

- Single-action generation is simpler and more transparent than statistical pattern analysis — the user sees exactly which action triggered the rule
- The pattern registry is explicit — adding a new action type requires adding a pattern function, not training a model
- Default-to-NOTIFY means auto-generated rules are always safe by default; the user must actively upgrade to AUTO
- Scope validation prevents accidentally broad rules (e.g., a rule matching thousands of past actions), but the threshold (100) is configurable
- Dangerous tools are hard-blocked at the safety layer — no amount of user approval can create an auto-execute rule for `delete_permanently`
- Name generation is deterministic and predictable — users can edit the suggested name, but the default is always human-readable
- The generic `tool_call` fallback handles unknown tools but produces less specific conditions — custom patterns should be added for frequently used tools
- No LLM is involved in rule generation — the entire flow is deterministic pattern matching and template expansion

## Code Example

```javascript
// User approves an email archive action and checks "Always allow this type"
const action = {
  id: 42,
  actionType: 'tool_call',
  parameters: {
    toolName: 'archive_email',
    toolArgs: { sender: 'noreply@github.com', subject: 'New PR review' },
    sender: 'noreply@github.com',
  },
}

const result = await createRuleSuggestion(action)
// {
//   canCreate: true,
//   rule: {
//     name: 'Notify on archive email from github.com',
//     description: 'When sender pattern: *@github.com, execute and notify you. Created from approved action #42.',
//     conditions: { type: 'email', action_type: 'archive', sender_pattern: '*@github.com' },
//     granted_tier: 'NOTIFY',   // Downgraded from AUTO for safety
//   },
//   suggestedTier: 'AUTO',      // Pattern suggested AUTO
//   matchCount: 23,              // 23 similar actions in last 30 days
// }

// User can then upgrade to AUTO if they want full autonomy
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Audit Trail with PII Sanitization](./audit-trail-with-pii-sanitization.md)
