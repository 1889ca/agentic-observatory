# Tunable Runtime Configuration

> A sync-read, async-write registry with three-tier resolution (DB preference > environment variable > code default), typed definitions with validation, and `warmCache()` at startup.

## Problem

Operational systems need adjustable knobs — tick intervals, batch sizes, rate limits, feature flags, cron schedules — but static config (env vars, config files) requires a process restart to change. User settings are per-user and inappropriate for system-wide concerns. Without a third tier, operators are stuck choosing between risky restarts and hardcoded defaults that can't respond to real-world conditions.

## Context

Applies to long-running agentic or server processes where:
- Some parameters need live adjustment during operation (e.g., slowing a cognitive loop under load, changing a cron schedule)
- Downtime from restarts is unacceptable or disruptive
- The values need to persist across restarts (not just in-process state)
- Changes must take effect system-wide, not per-user
- The set of tunables spans multiple domains: schedules, budgets, thresholds, timeouts, retention policies, UI config, tool settings

## Solution

### Three-Tier Resolution Chain

The tunables system (`lib/config/tunables.js`) resolves values through a priority chain. The highest-priority source wins:

1. **DB preference** (category `system`) — runtime-editable from the frontend or API
2. **Environment variable** (`RILEY_*`) — deploy-time override
3. **Code default** (from `define()`) — hardcoded fallback

```javascript
// lib/config/tunables.js
const definitions = new Map()  // key -> definition metadata
const cache = new Map()        // key -> resolved value (always populated)
let warmed = false
```

Every read hits the in-memory cache (sync). Every write persists to the DB and updates the cache (async).

### Typed Definitions with Validation

Tunables are defined at module load time with type, constraints, and metadata:

```javascript
// lib/config/tunables.js
function define(key, opts) {
  const def = {
    key,
    type: opts.type || 'string',      // 'number' | 'boolean' | 'cron' | 'string' | 'select'
    group: opts.group || 'misc',       // Grouping label for UI
    default: opts.default,
    label: opts.label || key,
    description: opts.description || '',
    envVar: opts.envVar || null,       // e.g., 'RILEY_TICK_INTERVAL'
    min: opts.min,                     // For numbers
    max: opts.max,                     // For numbers
    options: opts.options,             // For select type
    client: opts.client || false,      // If true, served to frontend
  }

  definitions.set(key, def)

  // Pre-populate cache: env var takes precedence over default
  const envValue = resolveEnvValue(def)
  cache.set(key, envValue !== undefined ? envValue : def.default)
}
```

Definitions are organized into domain-specific files loaded by `lib/config/tunables/index.js`:

```javascript
// lib/config/tunables/index.js
require('./schedules')    // Cron schedules for jobs
require('./budgets')      // Cost limits, token budgets
require('./thresholds')   // Confidence scores, complexity cutoffs
require('./timeouts')     // Job timeouts, connection timeouts
require('./retention')    // Data retention periods
require('./tools')        // Tool-specific settings
require('./ui')           // Frontend configuration
```

### Sync Read, Async Write

Reads are always synchronous — no await, no DB call, just a Map lookup:

```javascript
// lib/config/tunables.js
function get(key) {
  if (cache.has(key)) return cache.get(key)
  const def = definitions.get(key)
  return def ? def.default : undefined
}
```

Writes validate, coerce, persist to the preferences table, update the cache, and emit an event:

```javascript
// lib/config/tunables.js
async function set(key, value) {
  const def = definitions.get(key)
  if (!def) return { success: false, error: `Unknown tunable: ${key}` }

  const coerced = coerce(value, def.type)
  const { valid, reason } = validate(coerced, def)
  if (!valid) return { success: false, error: reason }

  // Persist via preferences (category='system')
  const preferences = require('./preferences')
  await preferences.set('system', key, coerced, {
    source: 'explicit',
    confidence: 1.0,
    context: { method: 'tunable_update', updatedAt: new Date().toISOString() },
  })

  const oldValue = cache.get(key)
  cache.set(key, coerced)

  // Emit change event for live-reload subscribers
  events.emit('tunable.changed', { key, value: coerced, oldValue, group: def.group })

  return { success: true }
}
```

### Type Coercion and Validation

Values are coerced from string representations (environment variables, DB values) to their declared type:

```javascript
// lib/config/tunables.js
function coerce(value, type) {
  if (value === null || value === undefined) return value
  switch (type) {
    case 'number':  { const n = Number(value); return Number.isNaN(n) ? undefined : n }
    case 'boolean': return value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : undefined
    case 'cron':
    case 'string':
    case 'select':  return String(value)
    default:        return value
  }
}

function validate(value, def) {
  if (value === null || value === undefined) return { valid: false, reason: 'Value is required' }
  if (def.type === 'number') {
    if (typeof value !== 'number') return { valid: false, reason: 'Must be a number' }
    if (def.min !== undefined && value < def.min) return { valid: false, reason: `Must be >= ${def.min}` }
    if (def.max !== undefined && value > def.max) return { valid: false, reason: `Must be <= ${def.max}` }
  }
  if (def.type === 'select' && def.options) {
    if (!def.options.includes(value)) return { valid: false, reason: `Must be one of: ${def.options.join(', ')}` }
  }
  return { valid: true }
}
```

### Warm Cache at Startup

`warmCache()` loads all `category='system'` preferences from the database and overlays them onto the cache. This runs once during the startup sequence, before the system begins processing:

```javascript
// lib/config/tunables.js
async function warmCache() {
  if (warmed) return

  try {
    const preferences = require('./preferences')
    const prefs = await preferences.getAll('system')

    for (const pref of prefs) {
      const def = definitions.get(pref.key)
      if (!def) continue
      const coerced = coerce(pref.value, def.type)
      if (coerced !== undefined) cache.set(pref.key, coerced)
    }

    warmed = true
    logger.info({ overrides: prefs.length, definitions: definitions.size }, 'Warmed tunables overrides from DB')
  } catch (error) {
    logger.warn({ err: error }, 'warmCache error')
    // Cache still has env-or-default values, so system continues working
  }
}
```

If the DB is unavailable at startup, warmCache logs a warning but does not crash — the cache already holds env-or-default values from `define()`.

### Reset to Default

Tunables can be reset, removing the DB override and reverting to the env-or-default value:

```javascript
// lib/config/tunables.js
async function reset(key) {
  const def = definitions.get(key)
  if (!def) return { success: false, error: `Unknown tunable: ${key}` }

  await preferences.remove('system', key)
  const envValue = resolveEnvValue(def)
  cache.set(key, envValue !== undefined ? envValue : def.default)

  events.emit('tunable.changed', { key, value: cache.get(key), group: def.group })
  return { success: true }
}
```

### Introspection

The `list()` and `listByGroup()` methods return all definitions with current values and source attribution (db/env/default), enabling admin UIs to display and edit tunables:

```javascript
// lib/config/tunables.js
function list() {
  const result = []
  for (const [key, def] of definitions) {
    const currentValue = cache.get(key)
    const envValue = resolveEnvValue(def)
    result.push({
      key, type: def.type, group: def.group, label: def.label,
      description: def.description, default: def.default,
      value: currentValue,
      source: currentValue !== def.default && currentValue !== envValue ? 'db' :
        envValue !== undefined && currentValue === envValue ? 'env' : 'default',
    })
  }
  return result
}
```

## Implications

- `warmCache()` adds a small startup cost; it must complete before processing begins to prevent cold-read surprises
- Sync reads mean zero overhead at call sites — no await, no try/catch, just `tunables.get(key)`
- The preferences table is reused (category='system') rather than a separate `tunables` table — this keeps the schema simpler but means tunables share storage with user preferences
- `tunable.changed` events enable live-reload of subscribers (e.g., cron schedules that need to re-register when their interval changes)
- Type coercion handles the impedance mismatch between string-typed env vars and typed tunables automatically
- Grouped definitions (schedules, budgets, thresholds, etc.) enable domain-organized admin UIs without custom frontend code
- The `client` flag controls which tunables are exposed to the frontend — system-internal values stay server-side

## Code Example

```javascript
// Defining tunables in a domain file
// lib/config/tunables/thresholds.js
const { define } = require('./')

define('thresholds.complexityForClaude', {
  type: 'number', group: 'thresholds', default: 0.7,
  label: 'Claude complexity threshold',
  description: 'Complexity score above which queries route to Claude',
  envVar: 'RILEY_CLAUDE_COMPLEXITY_THRESHOLD',
  min: 0, max: 1,
})

define('thresholds.preferenceInferenceMinConfidence', {
  type: 'number', group: 'thresholds', default: 0.7,
  label: 'Preference inference min confidence',
  min: 0, max: 1,
})

// Reading (sync, anywhere in the codebase)
const tunables = require('../config/tunables')
const threshold = tunables.get('thresholds.complexityForClaude')

// Updating (async, from admin API)
await tunables.set('thresholds.complexityForClaude', 0.8)

// Startup sequence
await tunables.warmCache()
await startProcessingLoop()  // Tunables are cache-hot before first tick
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Database Abstraction and Schema Management](./database-abstraction-and-schema-management.md)
- [Unified Event System](./unified-event-system.md)
