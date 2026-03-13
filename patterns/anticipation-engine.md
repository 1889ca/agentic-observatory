# Anticipation Engine

> Predict likely upcoming needs from temporal and sequential patterns, enabling proactive agent behavior instead of purely reactive responses.

## Problem

Reactive agents sit idle until a user makes a request, then scramble to gather context and produce a response. This misses opportunities to prepare in advance — pre-fetching relevant context before a meeting, drafting a summary before it's asked for, or surfacing a reminder before a deadline passes. The agent has access to historical patterns and calendar data that could predict what's coming next, but without a prediction system, this information goes unused.

## Context

- An agent with access to temporal data: calendars, schedules, historical usage patterns
- Recurring user behaviors that follow predictable sequences (e.g., standup notes every morning, weekly report every Friday)
- External signals like calendar events that imply upcoming needs (meeting in 30 minutes means meeting notes are needed soon)
- The agent can take low-cost preparatory actions (pre-fetching, drafting, caching) without user intervention
- A threshold system is needed to avoid annoying or incorrect proactive behavior

## Solution

### Pattern Tracking

Track two types of patterns: sequential (what follows what) and temporal (what happens when). Each observation reinforces the pattern's strength.

```javascript
// Sequential patterns: action A is frequently followed by action B
const sequentialPatterns = {
  store: new Map(), // key: actionA -> value: { actionB: count, actionC: count }

  observe(previousAction, currentAction) {
    if (!previousAction) return;
    const followers = this.store.get(previousAction) || {};
    followers[currentAction] = (followers[currentAction] || 0) + 1;
    this.store.set(previousAction, followers);
  },

  predict(currentAction) {
    const followers = this.store.get(currentAction);
    if (!followers) return [];

    const total = Object.values(followers).reduce((a, b) => a + b, 0);
    return Object.entries(followers)
      .map(([action, count]) => ({ action, confidence: count / total }))
      .sort((a, b) => b.confidence - a.confidence);
  }
};

// Temporal patterns: actions that recur at specific times/days
const temporalPatterns = {
  store: new Map(), // key: action -> value: [{ dayOfWeek, hour, count }]

  observe(action, timestamp) {
    const key = action;
    const slots = this.store.get(key) || [];
    const day = timestamp.getDay();
    const hour = timestamp.getHours();

    const existing = slots.find(s => s.dayOfWeek === day && s.hour === hour);
    if (existing) {
      existing.count++;
    } else {
      slots.push({ dayOfWeek: day, hour, count: 1 });
    }
    this.store.set(key, slots);
  },

  predictForTime(timestamp) {
    const day = timestamp.getDay();
    const hour = timestamp.getHours();
    const predictions = [];

    for (const [action, slots] of this.store) {
      const match = slots.find(s => s.dayOfWeek === day && s.hour === hour);
      if (match && match.count >= 3) { // minimum observation threshold
        predictions.push({
          action,
          confidence: Math.min(match.count / 10, 0.95), // cap at 95%
          basis: `observed ${match.count} times on ${dayName(day)} at ${hour}:00`
        });
      }
    }

    return predictions.sort((a, b) => b.confidence - a.confidence);
  }
};
```

### Calendar Integration

Calendar events provide high-confidence signals about upcoming needs. A meeting in 30 minutes strongly predicts the need for meeting-related context.

```javascript
async function getCalendarSignals(lookaheadMinutes = 60) {
  const upcoming = await calendar.getEvents({
    start: new Date(),
    end: new Date(Date.now() + lookaheadMinutes * 60 * 1000)
  });

  return upcoming.map(event => ({
    type: 'calendar',
    event: event.summary,
    startsIn: Math.round((event.start - Date.now()) / 60000),
    participants: event.attendees || [],
    anticipatedNeeds: inferNeeds(event)
  }));
}

function inferNeeds(event) {
  const needs = [];
  const title = event.summary.toLowerCase();

  if (title.includes('standup') || title.includes('sync')) {
    needs.push({ action: 'prepare-status-summary', confidence: 0.85 });
  }
  if (title.includes('review') || title.includes('retro')) {
    needs.push({ action: 'gather-recent-activity', confidence: 0.80 });
  }
  if (event.attendees?.length > 0) {
    needs.push({ action: 'fetch-participant-context', confidence: 0.70 });
  }

  return needs;
}
```

### Prediction Scoring and Threshold

All prediction sources feed into a unified scorer. Only predictions above a confidence threshold trigger proactive actions. The threshold is tunable — higher means fewer false positives but more missed opportunities.

```javascript
const CONFIDENCE_THRESHOLD = 0.6;

async function evaluatePredictions() {
  const now = new Date();
  const predictions = [];

  // Temporal patterns — what usually happens at this time?
  predictions.push(...temporalPatterns.predictForTime(now));

  // Sequential patterns — what usually follows the last action?
  const lastAction = await getLastUserAction();
  if (lastAction) {
    predictions.push(...sequentialPatterns.predict(lastAction.type));
  }

  // Calendar signals — what's coming up?
  const calendarSignals = await getCalendarSignals(60);
  for (const signal of calendarSignals) {
    for (const need of signal.anticipatedNeeds) {
      predictions.push({
        action: need.action,
        confidence: need.confidence,
        basis: `${signal.event} starts in ${signal.startsIn} minutes`,
        context: signal
      });
    }
  }

  // Filter to actionable predictions
  return predictions
    .filter(p => p.confidence >= CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);
}
```

### Proactive Action Execution

Predicted needs map to preparatory actions. These are low-cost, non-intrusive operations — fetching context, caching results, drafting content — that make the agent faster when the predicted need materializes.

```javascript
const PROACTIVE_ACTIONS = {
  'prepare-status-summary': async (context) => {
    const recentActivity = await getActivitySince(yesterday());
    return cache.set('status-summary', summarize(recentActivity), { ttl: 3600 });
  },
  'gather-recent-activity': async (context) => {
    const activity = await searchMemory('recent work completed');
    return cache.set('recent-activity', activity, { ttl: 3600 });
  },
  'fetch-participant-context': async (context) => {
    const participants = context.participants || [];
    const profiles = await Promise.all(
      participants.map(p => knowledgeGraph.expandGraph(p.name, 1))
    );
    return cache.set('participant-context', profiles, { ttl: 1800 });
  }
};

async function executeProactiveActions() {
  const predictions = await evaluatePredictions();

  for (const prediction of predictions) {
    const handler = PROACTIVE_ACTIONS[prediction.action];
    if (handler) {
      try {
        await handler(prediction.context);
        log.info(`Proactive: ${prediction.action} (${prediction.confidence}) — ${prediction.basis}`);
      } catch (err) {
        log.warn(`Proactive action failed: ${prediction.action}`, err);
        // Failures are non-critical — the user can still request manually
      }
    }
  }
}
```

### Anticipation Loop

The engine runs on an interval, continuously evaluating predictions and executing preparatory actions.

```javascript
function startAnticipationLoop(intervalMs = 5 * 60 * 1000) {
  setInterval(async () => {
    await executeProactiveActions();
  }, intervalMs);
}
```

## Implications

- False positives are annoying — if the engine acts on bad predictions, it wastes resources or surfaces irrelevant content. The confidence threshold must be tuned carefully
- Proactive actions must be cheap and reversible. Never take destructive or user-visible actions based on predictions alone
- Sequential patterns need a cold-start period — the engine is useless until it has observed enough repetitions
- Calendar integration requires API access and permissions, adding an external dependency
- The anticipation loop adds background load; interval and action cost should be monitored
- Users may find proactive behavior unsettling if it's too accurate or too visible — consider making it a "preparation" layer that speeds up responses rather than pushing unprompted notifications
- Pattern storage grows over time; periodic pruning of low-confidence, low-count patterns keeps the system focused

## Code Example

```javascript
// Complete anticipation cycle: observe, predict, prepare
class AnticipationEngine {
  constructor(config = {}) {
    this.threshold = config.confidenceThreshold || 0.6;
    this.lookaheadMinutes = config.lookaheadMinutes || 60;
    this.intervalMs = config.intervalMs || 5 * 60 * 1000;
  }

  // Called on every user action to build pattern history
  observe(action, previousAction) {
    const now = new Date();
    temporalPatterns.observe(action, now);
    sequentialPatterns.observe(previousAction, action);
  }

  // Evaluate all prediction sources
  async predict() {
    const predictions = await evaluatePredictions();
    return predictions.filter(p => p.confidence >= this.threshold);
  }

  // Run preparatory actions for high-confidence predictions
  async prepare() {
    const predictions = await this.predict();
    const results = [];

    for (const p of predictions) {
      const handler = PROACTIVE_ACTIONS[p.action];
      if (handler) {
        await handler(p.context);
        results.push({ action: p.action, confidence: p.confidence });
      }
    }

    return results;
  }

  start() {
    setInterval(() => this.prepare(), this.intervalMs);
  }
}
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
