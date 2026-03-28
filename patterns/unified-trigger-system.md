# Unified Trigger System

> DB-backed automation engine with CRUD management, cooldown tracking, 11 action types, wildcard event matching, cron scheduling, and resumable approval workflows.

## Problem

An agent system accumulates many "when X happens, do Y" behaviors: notify on new client, run a template when a project is created, generate LLM content on a schedule, chain multiple actions in sequence. Without a unified trigger system, each automation is a one-off handler scattered across the codebase. Adding new automations requires code changes. There is no way for users to create, edit, or disable automations without developer intervention. Cooldowns, execution logging, and approval gates must be reimplemented per handler.

## Context

- An agent that reacts to both time-based schedules (cron) and event-based triggers (entity created, email received, GitHub PR merged)
- Users need to create and manage their own automations through a CRUD interface, not by writing code
- Actions range from simple notifications to multi-step workflows with LLM generation and approval checkpoints
- Triggers need cooldowns to prevent storm behavior -- a burst of events should not fire the same trigger 50 times
- Both DB-persisted triggers (user-created) and in-memory programmatic triggers (system-built) coexist
- Legacy template triggers in a separate table must be supported alongside the new unified system

## Solution

### Layered Architecture

The trigger system is split into four modules: CRUD (persistence), executor (action dispatch), scheduling (cron matching), and system (built-in programmatic triggers). A thin index module composes them into a single public API.

```
unified-triggers/
  index.js        -- Public API, constants (ACTION_TYPES, EVENT_PATTERNS)
  crud.js         -- DB CRUD, pattern matching, legacy trigger compat
  executor.js     -- Action dispatch, cooldowns, programmatic registration
  scheduling.js   -- Cron expression matching (5-field + 6-field)
  system.js       -- Built-in system triggers (semantic scheduler)
  resumable.js    -- Approval checkpoints and workflow resume
```

### 11 Action Types

Each trigger maps to one of 11 action types. The executor dispatches based on `actionType`:

```javascript
const ACTION_TYPES = {
  NOTIFY: 'notify',              // Send notification via messenger
  TOOL: 'tool',                  // Execute a capability/tool
  JOB: 'job',                    // Trigger a registered job by name
  TEMPLATE: 'template',         // Execute a document template
  LLM_GENERATE: 'llm_generate', // Generate content with LLM
  CREATE_ATTENTION: 'create_attention', // Create attention item
  AUDIT_LOG: 'audit_log',       // Write audit log entry
  CHAIN: 'chain',               // Multiple actions in sequence
  EMIT: 'emit',                 // Emit another event (trigger chaining)
  DELAY: 'delay',               // Pause execution (within chains)
  APPROVAL: 'approval',         // Pause workflow for user approval
}
```

The executor routes to the appropriate handler:

```javascript
async function executeAction(actionType, actionConfig, eventData = {}, eventName = null) {
  switch (actionType) {
    case 'notify':
      return executeNotify(actionConfig, eventData)
    case 'tool':
      return executeTool(actionConfig, eventData)
    case 'job':
      return executeJob(actionConfig, eventData)
    case 'llm_generate':
      return executeLlmGenerate(actionConfig, eventData)
    case 'chain':
      return executeChain(actionConfig, eventData, eventName)
    case 'emit':
      return executeEmit(actionConfig, eventData)
    // ... 11 types total
  }
}
```

### CRUD Operations

Triggers are stored in the `unified_triggers` table with full create/read/update/delete operations. Each trigger specifies its type (schedule or event), its matching criteria, and its action configuration:

```javascript
async function create({ name, description, triggerType, schedule, scheduleHuman,
                        eventPattern, eventConditions, actionType, actionConfig }) {
  const id = await insert('unified_triggers', {
    name,
    description,
    trigger_type: triggerType,
    schedule: triggerType === 'schedule' ? schedule : null,
    event_pattern: triggerType === 'event' ? eventPattern : null,
    event_conditions: triggerType === 'event' ? JSON.stringify(eventConditions || {}) : null,
    action_type: actionType,
    action_config: JSON.stringify(actionConfig),
  })
  return get(id)
}
```

Listing supports filtering by enabled state, trigger type, event pattern, and limit:

```javascript
async function list(options = {}) {
  let query = select('unified_triggers').orderBy('created_at', 'DESC')
  if (options.enabled !== undefined) query = query.where('enabled = ?', options.enabled)
  if (options.triggerType) query = query.where('trigger_type = ?', options.triggerType)
  if (options.eventPattern) query = query.where('event_pattern = ?', options.eventPattern)
  return (await query.all()).map(normalizeTrigger)
}
```

### Event Pattern Matching with Wildcards

Event triggers use dot-notation patterns with wildcard support. `email.*` matches `email.received` and `email.sent`. `*.created` matches `entity.client_created`, `entity.project_created`, etc.:

```javascript
function matchesPattern(pattern, eventName) {
  if (pattern === eventName) return true
  if (pattern === '*') return true

  const patternParts = pattern.split('.')
  const eventParts = eventName.split('.')
  if (patternParts.length !== eventParts.length) return false

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] !== '*' && patternParts[i] !== eventParts[i]) return false
  }
  return true
}
```

The system ships with 15+ predefined event patterns covering entity lifecycle, email, GitHub, and focus events:

```javascript
const EVENT_PATTERNS = {
  CLIENT_CREATED: 'entity.client_created',
  PROJECT_CREATED: 'entity.project_created',
  GITHUB_PR_MERGED: 'github.pr_merged',
  EMAIL_RECEIVED: 'email.received',
  FOCUS_STARTED: 'focus.started',
  // ... 15+ patterns
}
```

### Cooldown Tracking

Cooldowns prevent trigger storms. The executor tracks last-fired timestamps per trigger in an in-memory Map. Before executing, it checks whether the cooldown period has elapsed:

```javascript
const cooldowns = new Map()

function isInCooldown(triggerId, cooldownMs) {
  if (!cooldownMs || cooldownMs <= 0) return false
  const lastFired = cooldowns.get(String(triggerId))
  if (!lastFired) return false
  return Date.now() - lastFired < cooldownMs
}

async function executeTrigger(trigger, eventData = {}, eventName = null) {
  const cooldownMs = trigger.cooldownMs || trigger.actionConfig?.cooldownMs || 0
  if (isInCooldown(trigger.id || trigger.name, cooldownMs)) {
    return { success: true, skipped: true, reason: 'cooldown' }
  }

  const result = await executeAction(trigger.actionType, trigger.actionConfig, eventData)
  recordCooldown(trigger.id || trigger.name)

  if (trigger.id) await crud.recordExecution(trigger.id)  // Increment DB counter
  return { success: true, result }
}
```

### Cron Scheduling

Schedule triggers use cron expressions. The system supports both standard 5-field (minute-level) and 6-field (second-level) cron. A critical invariant prevents 5-field expressions from matching more than once per minute, even if the scheduler ticks faster:

```javascript
function cronMatches(cronExpr, date = new Date()) {
  const fieldCount = parseFieldCount(cronExpr)
  if (fieldCount !== 5 && fieldCount !== 6) return false

  // Prevent multiple matches per minute for 5-field cron
  if (fieldCount === 5 && date.getSeconds() !== 0) return false

  const tick = normalizeTick(date, fieldCount)
  return isScheduledForTick(cronExpr, tick, getTz())
}
```

Human-readable schedule conversion is built in for common patterns:

```javascript
humanToCron('every weekday at 9:30 AM')  // → '30 9 * * 1-5'
humanToCron('every Monday at 8 AM')      // → '0 8 * * 1'
humanToCron('every 15 minutes')          // → '*/15 * * * *'
cronToHuman('0 20 * * 0')               // → 'every Sunday at 8:00 PM'
```

### Template Variable Interpolation

Action configurations support `{{variable}}` interpolation from event data, using dot-notation paths with optional `$.` prefix:

```javascript
function interpolate(template, data) {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getValueByPath(data, path.trim())
    return value !== undefined ? String(value) : match
  })
}

// Example: notify action with interpolated message
// actionConfig: { message: "New client: {{name}} ({{email}})" }
// eventData: { name: "Acme Corp", email: "hello@acme.com" }
// Result: "New client: Acme Corp (hello@acme.com)"
```

### Dual Source: DB + Programmatic

The system merges triggers from two sources. DB-backed triggers are user-created via CRUD. Programmatic triggers are registered in-memory by system code for built-in behaviors like the semantic scheduler:

```javascript
function register(trigger) {
  const normalized = {
    ...trigger,
    triggerType: trigger.schedule ? 'schedule' : 'event',
    source: 'programmatic',
  }
  programmaticTriggers.set(trigger.name, normalized)
}

async function executeEventTriggers(eventName, eventData = {}) {
  const dbTriggers = await crud.getForEvent(eventName)
  const progTriggers = Array.from(programmaticTriggers.values())
    .filter(t => crud.matchesPattern(t.eventPattern, eventName))

  const allTriggers = [...dbTriggers, ...progTriggers]
  // Execute all matching triggers with condition checks and cooldowns
}
```

### Resumable Approval Workflows

Chain actions can include `approval` steps that pause execution and return a resume token. The workflow state is persisted to the `workflow_executions` table. When the user approves, execution resumes from exactly where it stopped:

```javascript
// Chain with approval checkpoint
const actions = [
  { type: 'notify', config: { message: 'New client onboarding started' } },
  { type: 'template', config: { templateId: 5 } },
  { type: 'approval', config: { message: 'Send welcome email?' } },
  { type: 'tool', config: { toolName: 'send_email', toolArgs: { ... } } },
]

const result = await executeChainWithApproval(actions, eventData)
// result.needsApproval === true, result.resumeToken === 'rt_abc123...'

// Later, after user approval:
await resume('rt_abc123...', { approved: true })
// Execution continues from step 4 (send_email)
```

## Implications

- Cooldowns are in-memory only -- they reset on server restart, which could cause duplicate fires after a crash
- The dual-source design means a trigger name collision between DB and programmatic triggers is possible but not guarded against
- Legacy `template_triggers` table support adds query overhead to every event dispatch (two table scans)
- Wildcard pattern matching is segment-level only (`email.*` works, `email.rec*` does not)
- Chain actions execute sequentially with optional `stopOnError` -- no parallel execution or conditional branching
- Approval workflows persist state in the DB, so they survive restarts, but stale approvals accumulate without cleanup
- The `emit` action type enables trigger chaining (one trigger fires another) which can create infinite loops if misconfigured
- Human-to-cron conversion handles common patterns but falls back to null for unusual schedules -- the LLM handles edge cases

## Code Example

```javascript
const triggers = require('./lib/unified-triggers')

// Create a user-defined trigger: notify when a new client is created
await triggers.create({
  name: 'New client welcome',
  description: 'Send a notification when a new client is added',
  triggerType: 'event',
  eventPattern: 'entity.client_created',
  actionType: 'chain',
  actionConfig: {
    actions: [
      { type: 'notify', config: { message: 'New client: {{name}}' } },
      { type: 'create_attention', config: {
        title: 'Onboard {{name}}',
        priority: 'high',
      }},
    ],
  },
})

// List all enabled event triggers
const active = await triggers.list({ enabled: true, triggerType: 'event' })

// Fire all triggers matching an event
const results = await triggers.executeEventTriggers('entity.client_created', {
  name: 'Acme Corp',
  email: 'hello@acme.com',
})
// results: [{ triggerName: 'New client welcome', success: true, result: { results: [...] } }]
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
