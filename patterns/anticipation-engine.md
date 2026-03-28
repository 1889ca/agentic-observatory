# Anticipation Engine

> Proactive intelligence system that predicts user needs using temporal, sequential, calendar, and behavioral predictors -- preparing context before the user asks.

## Problem

An agent that only reacts to explicit requests always lags behind the user. If a user reviews PRs every morning at 9 AM, the agent should have summaries ready at 8:55. If a meeting with a client starts in 30 minutes, the agent should already be gathering recent emails, project status, and open invoices. Without predictive capability, the agent forces the user to repeatedly set up the same context -- or worse, enters meetings and work sessions unprepared.

## Context

- An agent with access to calendar, email, task management, and historical tool execution data
- Users develop habitual patterns: Monday planning, morning PR reviews, post-meeting todo creation, monthly invoicing
- Calendar events carry implicit preparation needs based on meeting type (client call vs. standup vs. design review)
- Predictions must have confidence thresholds -- acting on low-confidence predictions wastes attention
- Anticipatory actions should prepare context, not take autonomous action -- the user decides what to do with it

## Solution

### Architecture: Predictors + Actions

The anticipation engine separates prediction from execution. Predictors analyze context and return predictions with confidence scores. Each prediction includes a suggested action. The engine filters by confidence threshold, then hands off to action handlers that prepare (but do not autonomously execute) context for the user.

```
Predictors (predict what)     Actions (prepare how)
  temporal ──────────────────── suggest_focus
  calendar ──────────────────── prepare_meeting_context
  sequential ────────────────── show_calendar_summary
  client ────────────────────── prepare_client_context
  recurring ─────────────────── prepare_weekly_planning
  research ──────────────────── surface_meeting_research
```

### The Main Loop

The `anticipate()` function runs all registered predictors against the current context (time, day of week, recent activity), collects predictions above each predictor's confidence threshold, and sorts by confidence:

```javascript
async function anticipate(context = {}) {
  const now = new Date()
  const currentContext = {
    hour: timeUtils.getUserHour(),
    dayOfWeek: timeUtils.getUserDay(),
    minute: now.getMinutes(),
    timestamp: now,
    ...context,
  }

  const anticipatedActions = []

  for (const predictor of predictors.all) {
    try {
      const predictions = await predictor.predict(currentContext)

      for (const prediction of predictions) {
        if (prediction.confidence >= predictor.minConfidence) {
          anticipatedActions.push({
            type: predictor.name,
            prediction,
            action: prediction.suggestedAction,
            confidence: prediction.confidence,
            predictor: predictor.name,
          })
        }
      }
    } catch (err) {
      audit.log('anticipation:predictor_error', {
        predictor: predictor.name,
        error: err.message,
      })
    }
  }

  return anticipatedActions.sort((a, b) => b.confidence - a.confidence)
}
```

### Predictor Types

Each predictor implements a `predict(context)` method that returns an array of predictions. Each prediction carries a confidence score (0-1) and a suggested action with typed parameters.

**Temporal predictor** -- mines historical tool execution data to detect time-based habits. It queries the `tool_executions` table to find patterns like "user creates todos on Monday mornings" or "PR reviews happen weekday mornings at 9-10 AM":

```javascript
const temporalPredictor = {
  name: 'temporal',
  minConfidence: 0.6,

  async predict(context) {
    const predictions = []
    const { hour, dayOfWeek, minute } = context

    // Check learned peak productivity preferences
    const peakHour = await preferences.get('time', 'peak_productivity_hour')
    if (peakHour !== null && hour === peakHour - 1 && minute >= 30) {
      predictions.push({
        type: 'peak_productivity_approaching',
        confidence: 0.7,
        description: `Your peak productivity hour (${peakHour}:00) is approaching`,
        suggestedAction: { type: 'suggest_focus', params: { peakHour } },
      })
    }

    // Monday morning planning -- confidence scales with historical frequency
    if (dayOfWeek === 1 && hour >= 8 && hour <= 10) {
      const mondayPattern = await checkMondayPlanningPattern()
      if (mondayPattern.confidence > 0.5) {
        predictions.push({
          type: 'monday_planning',
          confidence: mondayPattern.confidence,
          suggestedAction: {
            type: 'prepare_weekly_planning',
            params: mondayPattern.data,
          },
        })
      }
    }

    return predictions
  },
}
```

Confidence is calculated from historical frequency -- for example, the Monday planning pattern queries how many times the user created todos/goals on Monday mornings in the last 30 days, then normalizes to a 0-0.9 range:

```javascript
async function checkMondayPlanningPattern() {
  const stats = await rawOne(
    `SELECT COUNT(*) as count FROM tool_executions
     WHERE tool_name IN ('add_todo', 'create_goal', 'set_weekly_focus')
       AND EXTRACT(DOW FROM created_at) = 1
       AND EXTRACT(HOUR FROM created_at) BETWEEN 8 AND 11
       AND created_at > NOW() - INTERVAL '30 days'`
  )
  const count = parseInt(stats?.count || 0)
  return { confidence: Math.min(count / 8, 0.9), data: { historicalCount: count } }
}
```

**Calendar predictor** -- fetches upcoming Google Calendar events and triggers meeting preparation 15-30 minutes before start. Cross-references attendees against known contacts and client records:

```javascript
const calendarPredictor = {
  name: 'calendar',
  minConfidence: 0.7,

  async predict(context) {
    const events = await google.listEvents({
      timeMin: now.toISOString(),
      timeMax: soon.toISOString(),
      maxResults: 5,
    })

    for (const event of events) {
      const minutesUntil = Math.round((startTime - now) / (60 * 1000))

      if (minutesUntil >= 15 && minutesUntil <= 30) {
        const attendees = event.attendees || []
        const knownPeople = await findKnownPeople(
          attendees.filter(a => !a.self).map(a => a.email)
        )

        predictions.push({
          type: 'upcoming_meeting',
          confidence: 0.85,
          suggestedAction: {
            type: 'prepare_meeting_context',
            params: { event, minutesUntil, knownPeople },
          },
        })
      }
    }
  },
}
```

**Sequential predictor** -- tracks recent tool executions to detect behavioral sequences. After email triage, suggest checking the calendar. After a meeting ends, suggest creating follow-up todos. After PR reviews, suggest running tests:

```javascript
const sequentialPredictor = {
  name: 'sequential',
  minConfidence: 0.6,

  async predict(context) {
    const recentTools = await getRecentToolExecutions(30) // Last 30 minutes
    const lastTool = recentTools[0]

    if (lastTool?.tool_name === 'list_emails' || lastTool?.tool_name === 'triage_email') {
      predictions.push({
        type: 'post_email_calendar',
        confidence: emailCalendarPattern.confidence,
        suggestedAction: { type: 'show_calendar_summary', params: {} },
      })
    }
  },
}
```

**Research predictor** -- the most sophisticated predictor. Detects upcoming meetings 30-60 minutes out, classifies them by type (design review, client call, standup, 1:1, interview, project update, performance review), then gathers type-specific context. For a client call, it fetches recent emails, invoices, and project status. For a standup, it gathers in-progress tasks and recent completions:

```javascript
function detectMeetingType(event) {
  const combined = `${event.summary} ${event.description || ''}`.toLowerCase()

  if (/client|customer|sales call|demo/.test(combined))
    return { type: 'client_call', label: 'client call' }
  if (/standup|stand-up|daily scrum|sprint/.test(combined))
    return { type: 'standup', label: 'stand-up' }
  if (/1:1|one-on-one|check-in/.test(combined))
    return { type: 'one_on_one', label: '1:1' }
  // ... 8 meeting types total
}
```

### Action Handlers

Actions prepare context and surface it to the user. They query databases, fetch external data, and package results -- but never take autonomous action. Each handler returns a structured result that the UI can render:

```javascript
const prepareMeetingContext = {
  name: 'prepare_meeting_context',
  async execute(params, prediction) {
    const { event, knownPeople } = params

    const context = { people: [], recentInteractions: [], relatedTasks: [] }

    for (const person of knownPeople) {
      const interactions = await raw(
        `SELECT type, summary, created_at FROM interactions
         WHERE person_id = $1 ORDER BY created_at DESC LIMIT 3`, [person.id]
      )
      context.people.push({ name: person.title, interactions })
    }

    // Match meeting keywords to open tasks
    const keywords = extractKeywords(event.summary)
    const relatedTasks = await raw(
      `SELECT id, title FROM tasks
       WHERE status IN ('pending', 'in_progress')
       AND (${keywords.map((_, i) => `title ILIKE $${i+1}`).join(' OR ')})`,
      keywords.map(k => `%${k}%`)
    )

    return { type: 'meeting_prep', event, people: context.people, relatedTasks }
  },
}
```

### Feedback Learning

Every anticipation is logged to the `anticipation_log` table with predictor name, confidence, action type, and outcome. Users can mark anticipations as helpful or unhelpful, which feeds back into future predictions:

```javascript
async function recordAnticipation(anticipation, result) {
  await raw(
    `INSERT INTO anticipation_log
     (predictor, prediction_type, confidence, action_type, action_params, success, result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [anticipation.predictor, anticipation.type, anticipation.confidence,
     anticipation.action?.type, JSON.stringify(anticipation.action?.params || {}),
     result.success, JSON.stringify(result)]
  )
}
```

## Implications

- Each predictor has an independent confidence threshold (`minConfidence`), so noisy predictors can be tuned without affecting reliable ones
- The temporal predictor relies on historical `tool_executions` data -- it needs weeks of usage before patterns emerge with high confidence
- Calendar predictions are high-confidence (0.85) because calendar events are explicit signals, not inferred patterns
- Sequential predictions are the weakest link -- the `checkSequencePattern` function is currently a stub returning 0.5 confidence
- The research predictor's meeting-type classification uses regex heuristics, which will miss unusual meeting titles
- All anticipatory actions are non-destructive -- they prepare and surface context, never take autonomous action
- Predictor errors are caught and logged per-predictor, so one failing predictor does not block the others
- The feedback loop exists structurally but is not yet wired to dynamically adjust predictor confidence thresholds

## Code Example

```javascript
// Run anticipation engine (typically called by a scheduled job)
const anticipations = await anticipate()

for (const anticipation of anticipations) {
  // Act on each prediction (prepare context, surface suggestions)
  const result = await act(anticipation)

  if (result.success && result.result?.type === 'meeting_prep') {
    // Surface meeting preparation to user
    await messenger.text(
      `Prepared context for "${result.result.event.title}" ` +
      `(${result.result.people.length} known attendees, ` +
      `${result.result.relatedTasks.length} related tasks)`
    )
  }
}

// Check prediction accuracy over last 7 days
const stats = await getStats(7)
// Returns: [{ predictor: 'calendar', total: 42, successful: 38, avg_confidence: 0.82 }]
```

## Related Patterns

- [Situation Detection and Context Awareness](./situation-detection-and-context-awareness.md)
- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Attention Item Management](./attention-item-management.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
