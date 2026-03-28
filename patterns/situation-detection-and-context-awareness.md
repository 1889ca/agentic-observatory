# Situation Detection and Context Awareness

> Runtime detection of user situations (in a meeting, deep work, traveling, stressed) that adjusts agent behavior through structured behavior objects and priority-based merging.

## Problem

An AI agent that behaves identically regardless of what the user is currently doing becomes either intrusive or unhelpful. Sending a deployment notification while the user is presenting to a client is disruptive. Offering task suggestions when the user is overwhelmed adds cognitive load instead of reducing it. Agents need situational awareness -- the ability to detect what's happening around the user and adjust their behavior accordingly. But hard-coding behavioral rules into every tool creates a maintenance nightmare and makes the system brittle to new situations.

## Context

- An orchestrator that interacts with users across multiple channels and time zones
- External signals available: calendar APIs, focus mode status, time-of-day data, health/wellness metrics
- Multiple situations can overlap (e.g., "weekend" and "late_night" simultaneously)
- Behavioral adjustments range from tone changes to notification suppression to proactive action gating
- The system should degrade gracefully when detection signals are unavailable
- Manual situations (traveling, vacation) coexist with auto-detected ones

## Solution

### Situation Definitions with Structured Behaviors

Each situation is a named object with a type classification, detection method, priority for conflict resolution, and a structured `behaviors` object that describes how the agent should adapt:

```javascript
// lib/situations/definitions.js
const SITUATIONS = {
  in_meeting: {
    type: 'activity',
    detection: 'calendar',
    priority: 80,
    behaviors: {
      notifications: 'silent',
      tone: 'brief',
      interruptions: 'block',
      proactiveSuggestions: false,
    },
  },

  deep_work: {
    type: 'activity',
    detection: 'focus_mode',
    priority: 70,
    behaviors: {
      notifications: 'minimal',
      tone: 'focused',
      interruptions: 'block',
      proactiveSuggestions: false,
      briefings: 'defer',
    },
  },

  morning: {
    type: 'temporal',
    detection: 'time',
    timeRange: { start: 6, end: 10 },
    priority: 20,
    behaviors: {
      tone: 'energetic',
      proactive: ['briefing', 'priority_todos'],
    },
  },

  late_night: {
    type: 'temporal',
    detection: 'time',
    timeRange: { start: 22, end: 6 }, // wraps around midnight
    priority: 30,
    behaviors: {
      tone: 'calm',
      proactiveSuggestions: false,
      notifications: 'minimal',
    },
  },

  vacation: {
    type: 'manual',
    detection: 'manual',
    priority: 90,
    behaviors: {
      notifications: 'emergency_only',
      tone: 'relaxed',
      interruptions: 'block',
      proactiveSuggestions: false,
      briefings: 'skip',
    },
  },

  // Wellness-based situations (auto-detected from health data)
  stressed: {
    type: 'wellness',
    detection: 'health_data',
    healthCondition: { metric: 'stress', threshold: 7, comparison: 'gte' },
    priority: 45,
    behaviors: {
      tone: 'calm_supportive',
      proactiveSuggestions: 'wellness_only',
      taskSuggestions: 'reduce',
      offerWellnessCheck: true,
    },
  },

  overwhelmed: {
    type: 'wellness',
    detection: 'health_data',
    healthCondition: {
      type: 'compound',
      conditions: [
        { metric: 'stress', threshold: 7, comparison: 'gte' },
        { metric: 'energy', threshold: 4, comparison: 'lte' },
      ],
      require: 'all',
    },
    priority: 55,
    behaviors: {
      tone: 'very_supportive',
      proactiveSuggestions: false,
      taskSuggestions: 'block',
      interruptions: 'gentle',
      offerSupport: true,
      reduceCognitiveLoad: true,
    },
  },
};
```

Key design decision: behaviors are structured objects (not hint arrays). Each property maps to a specific behavioral dimension -- `notifications`, `tone`, `interruptions`, `proactiveSuggestions` -- making them machine-readable for downstream consumers rather than relying on LLM interpretation of free-text hints.

### Four Situation Types

Situations fall into four categories, each with a different detection mechanism:

1. **Activity** -- detected from external signals like calendar events (`in_meeting`) or OS focus mode (`deep_work`)
2. **Temporal** -- detected from time of day (`morning`, `late_night`, `end_of_day`) or day of week (`weekend`)
3. **Manual** -- user-activated situations stored in the database (`traveling`, `vacation`, `presenting`)
4. **Wellness** -- auto-detected from health/mood tracking data with threshold conditions (`stressed`, `low_energy`, `overwhelmed`)

### Parallel Detection

The detector runs all detection sources concurrently. Each source is isolated -- a failure in one doesn't affect others:

```javascript
// lib/situations/detector.js
async function detect(options = {}) {
  const { skipCache = false, manualSituations = [] } = options;
  const active = [];

  // Run all async detections in PARALLEL
  const [focusResult, calendarResult, healthStats] = await Promise.all([
    detectFocusMode().catch(() => false),
    detectCalendarMeeting().catch(() => ({ inMeeting: false, event: null })),
    getHealthStats().catch(() => ({})),
  ]);

  // Process each detection source
  if (focusResult) {
    active.push({ name: 'deep_work', definition: SITUATIONS.deep_work, source: 'detected' });
  }

  if (calendarResult.inMeeting) {
    active.push({ name: 'in_meeting', definition: SITUATIONS.in_meeting, source: 'detected' });
  }

  // Time-based (synchronous, no external calls)
  for (const [name, def] of Object.entries(getByDetection('time'))) {
    if (def.timeRange && isInTimeRange(def.timeRange)) {
      active.push({ name, definition: def, source: 'detected' });
    }
  }

  // Health-based situations
  active.push(...detectHealthSituations(healthStats));

  // Manual situations from DB
  for (const manual of manualSituations) {
    if (!manual.expiresAt || new Date(manual.expiresAt) > new Date()) {
      active.push({ name: manual.name, definition: getDefinition(manual.name), source: 'manual' });
    }
  }

  return active;
}
```

Detection results are cached for 5 seconds to avoid redundant work during a single request cycle. Health stats use a longer 60-second cache since they change slowly.

### Priority-Based Behavior Merging

When multiple situations are active simultaneously, their behaviors are merged with higher-priority situations overriding lower-priority ones:

```javascript
// lib/situations/index.js
async function getBehaviors() {
  const active = await detect();

  // Sort by priority (lower first, so higher priority overrides)
  const sorted = [...active].sort((a, b) => a.definition.priority - b.definition.priority);

  // Merge behaviors -- higher priority wins on conflicts
  const behaviors = {};
  for (const situation of sorted) {
    Object.assign(behaviors, situation.definition.behaviors);
  }

  return behaviors;
}
```

### Suppression Checks

Downstream systems query the situation layer to decide whether to proceed with actions:

```javascript
async function shouldSuppress(action) {
  const behaviors = await getBehaviors();

  if (action === 'notification') {
    if (behaviors.notifications === 'silent') {
      return { suppress: true, reason: 'Notifications are silenced' };
    }
    if (behaviors.notifications === 'emergency_only') {
      return { suppress: true, reason: 'Only emergency notifications allowed' };
    }
  }

  if (action === 'interruption' && behaviors.interruptions === 'block') {
    return { suppress: true, reason: 'Interruptions are blocked' };
  }

  if (action === 'proactive' && behaviors.proactiveSuggestions === false) {
    return { suppress: true, reason: 'Proactive suggestions disabled' };
  }

  return { suppress: false };
}
```

### Manual Activation with DB Persistence

Manual situations are stored in the database with optional expiry, surviving process restarts:

```javascript
async function activate(name, options = {}) {
  const { source = 'manual', expiresAt = null, data = {} } = options;
  const def = definitions.getDefinition(name);

  // Get or create the context in the database
  let context = await rawOne('SELECT id FROM contexts WHERE name = $1', [name]);

  if (!context && def) {
    await insert('contexts', {
      name,
      type: def.type,
      behaviors: JSON.stringify(def.behaviors),
      priority: def.priority,
    });
    context = await rawOne('SELECT id FROM contexts WHERE name = $1', [name]);
  }

  await insert('active_contexts', {
    context_id: context.id,
    activated_by: source,
    activation_data: JSON.stringify(data),
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
  });

  // Log to history for pattern analysis
  await insert('context_history', { context_id: context.id, context_name: name });

  detector.clearCache();
  return { success: true };
}
```

## Implications

- Structured behaviors (not free-text hints) make situation effects machine-testable -- you can assert that `getBehaviors().notifications === 'silent'` during a meeting without parsing natural language
- Detection runs as a pre-processing step with parallel execution and caching -- negligible latency impact since detectors use cached data, not LLM calls
- Wellness situations add empathy-aware behavior -- the agent reduces cognitive load when the user reports high stress, rather than pushing more tasks
- Priority-based merging is simple but effective -- vacation (priority 90) overrides weekend (priority 15), and meeting (80) overrides morning (20)
- Manual situations persist in the database with expiry dates, so "I'm traveling until Friday" survives process restarts and auto-deactivates
- Graceful degradation: if any detection source fails (calendar API down, no health data), it returns a safe default and other detectors continue normally
- The `shouldSuppress` API provides a clean integration point -- notification systems, proactive features, and briefing generators all check situations before acting
- Compound health conditions (e.g., `overwhelmed` requires both high stress AND low energy) prevent false positives from single-metric spikes

## Code Example

```javascript
// Full usage: detect situations and adjust behavior
const situations = require('./lib/situations');

// Get all currently active situations
const active = await situations.getActive();
// → [{ name: 'morning', type: 'temporal', priority: 20 },
//    { name: 'stressed', type: 'wellness', priority: 45 }]

// Get merged behaviors
const behaviors = await situations.getBehaviors();
// → { tone: 'calm_supportive', proactiveSuggestions: 'wellness_only',
//    proactive: ['briefing', 'priority_todos'], taskSuggestions: 'reduce' }

// Check before sending notification
const { suppress, reason } = await situations.shouldSuppress('notification');
if (suppress) {
  logger.info(`Notification suppressed: ${reason}`);
}

// Get the current tone for response generation
const tone = await situations.getTone();
// → 'calm_supportive' (stressed overrides morning's 'energetic')

// Manually activate a situation
await situations.activate('traveling', {
  expiresAt: '2024-01-15T00:00:00Z',
  data: { destination: 'Tokyo' },
});

// Check specific situation
if (await situations.isActive('deep_work')) {
  // Don't interrupt
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
