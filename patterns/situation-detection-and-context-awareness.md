# Situation Detection and Context Awareness

> Runtime detection of user situations (in a meeting, on mobile, debugging, deploying) that adjusts agent behavior through prompt-injected hints rather than hard-coded tool restrictions.

## Problem

An AI agent that behaves identically regardless of what the user is currently doing becomes either intrusive or unhelpful. Sending a deployment notification while the user is presenting to a client is disruptive. Generating a detailed code walkthrough when the user is on mobile and needs a quick answer wastes their time. Agents need situational awareness — the ability to detect what's happening around the user and adjust their behavior accordingly. But hard-coding behavioral rules into every tool creates a maintenance nightmare and makes the system brittle to new situations.

## Context

- An orchestrator that interacts with users across multiple channels and time zones
- External signals available: calendar APIs, user status indicators, conversation patterns, time-of-day data
- Multiple situations can overlap (e.g., "on mobile" and "in a meeting" simultaneously)
- Behavioral adjustments range from tone changes to tool suppression
- The system should degrade gracefully when detection signals are unavailable

## Solution

### Situation Registry

Each situation is a named object with detection rules, behavioral hints, a priority for conflict resolution, and a TTL for automatic expiry:

```javascript
// situations/registry.js
const situations = {
  'in-meeting': {
    priority: 90,
    ttlMs: 2 * 60 * 60 * 1000, // 2 hours max
    hints: [
      'User is in a meeting. Keep responses extremely brief.',
      'Do NOT send notifications to external channels.',
      'Prefer bullet points over prose.',
    ],
    suppressTools: ['send-notification', 'deploy', 'schedule-message'],
  },

  'on-mobile': {
    priority: 70,
    ttlMs: 4 * 60 * 60 * 1000,
    hints: [
      'User is on mobile. Keep responses short and scannable.',
      'Avoid code blocks longer than 10 lines.',
      'Prefer summaries over full details — offer to expand if needed.',
    ],
    suppressTools: [],
  },

  'debugging': {
    priority: 50,
    ttlMs: 60 * 60 * 1000,
    hints: [
      'User is actively debugging. Prioritize precision over brevity.',
      'Include line numbers, stack traces, and exact error messages.',
      'Suggest diagnostic steps rather than jumping to conclusions.',
    ],
    suppressTools: [],
  },

  'in-deploy': {
    priority: 80,
    ttlMs: 30 * 60 * 1000,
    hints: [
      'A deployment is in progress. Minimize non-critical interruptions.',
      'Prioritize deployment-related queries over everything else.',
      'Surface health check results proactively.',
    ],
    suppressTools: ['consolidate-memory', 'run-reflection'],
  },
};
```

### Detection Sources

Situations are detected through multiple lightweight sources, each returning zero or more situation activations:

```javascript
// situations/detectors.js
const detectors = [
  // Calendar integration — check for active/upcoming meetings
  async function calendarDetector(userId) {
    const events = await calendar.getCurrentEvents(userId);
    if (!events.length) return [];

    const inMeeting = events.some(e => e.status === 'active');
    return inMeeting ? [{ situation: 'in-meeting', source: 'calendar', expiresAt: events[0].end }] : [];
  },

  // Channel signal — mobile clients send a device header
  function channelDetector(userId, messageContext) {
    if (messageContext?.deviceType === 'mobile') {
      return [{ situation: 'on-mobile', source: 'channel-header' }];
    }
    return [];
  },

  // Conversation analysis — detect debugging patterns from recent messages
  function conversationDetector(userId, messageContext, recentHistory) {
    const debugIndicators = ['stack trace', 'error', 'bug', 'TypeError', 'undefined is not', 'segfault'];
    const recentTexts = recentHistory.slice(0, 5).map(m => m.content).join(' ').toLowerCase();
    const matches = debugIndicators.filter(i => recentTexts.includes(i.toLowerCase()));

    if (matches.length >= 2) {
      return [{ situation: 'debugging', source: 'conversation-analysis' }];
    }
    return [];
  },

  // System state — detect active deployments
  async function deployDetector(userId) {
    const activeDeploys = await deploys.getActive(userId);
    if (activeDeploys.length > 0) {
      return [{ situation: 'in-deploy', source: 'deploy-tracker' }];
    }
    return [];
  },
];
```

### Situation Activation and Stacking

Multiple situations can be active simultaneously. The activation manager tracks active situations, handles expiry, and resolves conflicts when hints contradict each other:

```javascript
// situations/manager.js
const activeSituations = new Map(); // userId -> Map<situationName, activation>

async function detectSituations(userId, messageContext, recentHistory) {
  // Run all detectors in parallel — each is lightweight, no LLM calls
  const detections = await Promise.all(
    detectors.map(d => d(userId, messageContext, recentHistory).catch(() => []))
  );
  const flat = detections.flat();

  const userSituations = activeSituations.get(userId) ?? new Map();

  // Activate new situations
  for (const detection of flat) {
    const definition = situations[detection.situation];
    if (!definition) continue;

    userSituations.set(detection.situation, {
      ...definition,
      activatedAt: Date.now(),
      expiresAt: detection.expiresAt ?? Date.now() + definition.ttlMs,
      source: detection.source,
    });
  }

  // Expire stale situations
  for (const [name, activation] of userSituations) {
    if (Date.now() > activation.expiresAt) {
      userSituations.delete(name);
    }
  }

  activeSituations.set(userId, userSituations);
  return userSituations;
}
```

### Priority-Based Conflict Resolution

When multiple active situations provide conflicting hints (e.g., "be brief" vs. "be detailed"), the higher-priority situation wins:

```javascript
// situations/resolver.js
function resolveHints(userSituations) {
  // Sort by priority descending
  const sorted = [...userSituations.values()]
    .sort((a, b) => b.priority - a.priority);

  const hints = [];
  const suppressedTools = new Set();

  for (const situation of sorted) {
    hints.push(...situation.hints);
    situation.suppressTools.forEach(t => suppressedTools.add(t));
  }

  return { hints, suppressedTools };
}
```

### Prompt Injection (Not Hard-Coding)

Situations modify behavior through system prompt injection, not by altering tool logic. The tool declarations remain unchanged — the LLM receives hints about what to avoid and decides accordingly:

```javascript
// situations/injector.js
function injectSituationalContext(systemPrompt, userSituations) {
  if (userSituations.size === 0) return systemPrompt;

  const { hints, suppressedTools } = resolveHints(userSituations);

  const situationBlock = [
    '## Active Situations',
    ...hints.map(h => `- ${h}`),
  ];

  if (suppressedTools.size > 0) {
    situationBlock.push('');
    situationBlock.push('## Tool Restrictions (current situation)');
    situationBlock.push(`Avoid using these tools unless the user explicitly requests them: ${[...suppressedTools].join(', ')}`);
  }

  return systemPrompt + '\n\n' + situationBlock.join('\n');
}
```

The key design decision: tool restrictions are expressed as hints ("avoid using"), not enforced blocks. If the user explicitly says "deploy now" during a meeting, the LLM can still call the deploy tool. The hints shift default behavior without removing capabilities.

## Implications

- Detection runs as a pre-processing step before context assembly — it adds negligible latency because detectors use cached data and simple heuristics, not LLM calls
- Prompt injection keeps tool logic clean — tools don't need to know about situations, and new situations can be added without modifying any tool code
- Hints are advisory, not mandatory — the LLM can override them when the user's explicit intent contradicts the situation, preserving user agency
- TTL-based expiry prevents stale situations from persisting indefinitely, but may expire too early if a meeting runs long; calendar-sourced expirations are more accurate
- Priority-based resolution is simple but coarse — two situations with the same priority will both contribute hints without conflict resolution between them
- Graceful degradation: if a detector fails (calendar API down, no device header), it returns an empty array and other detectors continue normally
- Situation stacking means the agent can be simultaneously "on mobile" and "in a meeting," receiving hints from both — the combined effect is more restrictive than either alone

## Code Example

```javascript
// Complete situation detection and injection during message processing
async function processMessageWithSituations(message, userId, messageContext) {
  const recentHistory = await getRecentHistory(userId, 5);

  // Detect active situations — runs all detectors in parallel
  const userSituations = await detectSituations(userId, messageContext, recentHistory);

  // Build base system prompt (persona, capabilities, anti-patterns)
  let systemPrompt = await buildSystemPrompt(userId);

  // Inject situational context as hints
  systemPrompt = injectSituationalContext(systemPrompt, userSituations);

  // Log active situations for observability
  if (userSituations.size > 0) {
    const names = [...userSituations.keys()];
    logger.info(`Active situations for ${userId}: ${names.join(', ')}`);
  }

  // Assemble context and dispatch to LLM with situation-aware prompt
  const context = await assembleContext(message, 'user');
  const response = await dispatch(systemPrompt, context, message);

  return response;
}

// Example: user sends a message while in a meeting on mobile
// Detected situations: 'in-meeting' (priority 90), 'on-mobile' (priority 70)
// Injected hints:
//   - User is in a meeting. Keep responses extremely brief.
//   - Do NOT send notifications to external channels.
//   - Prefer bullet points over prose.
//   - User is on mobile. Keep responses short and scannable.
//   - Avoid code blocks longer than 10 lines.
// Suppressed tools: send-notification, deploy, schedule-message
// Result: LLM gives a 3-bullet response instead of a detailed explanation
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
