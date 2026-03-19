# Relationship Health Monitoring

> Background scoring of communication frequency per contact with decay-based health metrics, neglect detection, and proactive outreach suggestion generation.

## Problem

An agent managing communications across dozens or hundreds of contacts has no innate sense of which relationships are thriving and which are going cold. Without tracking communication frequency and recency against expected cadence, important contacts silently decay. A key client who hasn't heard from you in six weeks looks identical to one you spoke with yesterday — the agent has no signal to differentiate them. By the time someone notices a neglected relationship, the damage is already done: deals go stale, friendships atrophy, and professional networks degrade through pure inattention rather than intent.

## Context

- Multi-contact communication management where the agent handles or observes interactions across email, messaging, and calendar
- Contacts with varying expected communication frequencies — a close collaborator expects weekly check-ins, a quarterly client expects seasonal updates
- Need for proactive relationship maintenance rather than purely reactive communication
- The agent already processes or has access to communication events (sent/received messages, meetings, calls)
- Relationship categories or tiers exist (or can be inferred) to set baseline expectations

## Solution

### Per-Contact Health Scoring

Each contact maintains a health record that tracks communication recency, frequency, and trend. The health score uses exponential decay — it starts at 1.0 after a communication event and decays toward 0 based on how long ago the last interaction occurred relative to the contact's expected cadence:

```javascript
// lib/relationship-health.js

const DEFAULT_CADENCE_DAYS = {
  inner_circle: 7,
  active_client: 14,
  colleague: 30,
  extended_network: 90,
  dormant: 180,
};

function computeHealthScore(contact) {
  const cadenceDays = contact.expectedCadenceDays
    || DEFAULT_CADENCE_DAYS[contact.category]
    || 30;

  const daysSinceContact = (Date.now() - new Date(contact.lastContactAt).getTime())
    / 86400000;

  // Exponential decay where the score hits 0.5 at exactly the cadence boundary
  const score = Math.pow(0.5, daysSinceContact / cadenceDays);

  return Math.round(score * 1000) / 1000;
}
```

A contact with a 14-day cadence scores 0.5 at exactly 14 days since last contact, 0.25 at 28 days, and 0.125 at 42 days. The decay is smooth and continuous — there is no hard cliff where a relationship suddenly becomes "neglected."

### Relationship Metadata

Each contact record carries metadata that accumulates over time, providing the raw material for health calculations and outreach decisions:

```javascript
// lib/relationship-health.js

async function getContactHealth(contactId) {
  const row = await db.query(`
    SELECT
      c.id,
      c.name,
      c.category,
      c.expected_cadence_days,
      c.last_contact_at,
      c.last_contact_direction,
      c.total_interactions,
      c.interactions_last_30d,
      c.sentiment_trend,
      c.created_at
    FROM contacts c
    WHERE c.id = $1
  `, [contactId]);

  if (!row) return null;

  const contact = row;
  contact.healthScore = computeHealthScore(contact);
  contact.status = classifyStatus(contact.healthScore);

  return contact;
}

function classifyStatus(score) {
  if (score >= 0.7) return 'healthy';
  if (score >= 0.4) return 'cooling';
  if (score >= 0.15) return 'neglected';
  return 'dormant';
}
```

The `sentiment_trend` field tracks whether recent interactions have been positive, neutral, or declining — a relationship can be frequent but deteriorating, which is a different signal than simple neglect.

### Communication Event Recording

When the agent observes or participates in a communication event, it updates the contact's health metadata:

```javascript
// lib/relationship-health.js

async function recordInteraction(contactId, { direction, channel, sentiment }) {
  await db.query(`
    UPDATE contacts SET
      last_contact_at = NOW(),
      last_contact_direction = $2,
      total_interactions = total_interactions + 1,
      interactions_last_30d = interactions_last_30d + 1,
      sentiment_trend = CASE
        WHEN $4 IS NOT NULL THEN
          (COALESCE(sentiment_trend, 0) * 0.7 + $4 * 0.3)
        ELSE sentiment_trend
      END
    WHERE id = $1
  `, [contactId, direction, channel, sentiment]);
}
```

Sentiment is stored as a running exponential average (70/30 old/new), so a single bad interaction shifts the trend without overwriting history.

### Background Health Scan

A periodic tick scans all contacts and identifies those needing attention. This runs as a background job — not on every request — to avoid adding latency to the communication path:

```javascript
// lib/relationship-health.js

async function scanForNeglectedContacts({ neglectThreshold = 0.3 } = {}) {
  const contacts = await db.query(`
    SELECT id, name, category, expected_cadence_days,
           last_contact_at, last_contact_direction,
           total_interactions, sentiment_trend
    FROM contacts
    WHERE category != 'dormant'
    ORDER BY last_contact_at ASC
  `);

  const neglected = [];

  for (const contact of contacts.rows) {
    const score = computeHealthScore(contact);
    if (score < neglectThreshold) {
      neglected.push({
        ...contact,
        healthScore: score,
        status: classifyStatus(score),
        daysSinceContact: Math.floor(
          (Date.now() - new Date(contact.lastContactAt).getTime()) / 86400000
        ),
      });
    }
  }

  return neglected;
}
```

The scan explicitly excludes contacts categorized as `dormant` — these are intentionally low-frequency and should not trigger neglect alerts.

### Proactive Outreach Suggestions

Once neglected contacts are identified, the system generates actionable outreach suggestions. Suggestions are ranked by a combination of neglect severity and relationship importance:

```javascript
// lib/relationship-health.js

const CATEGORY_WEIGHT = {
  inner_circle: 1.0,
  active_client: 0.9,
  colleague: 0.5,
  extended_network: 0.2,
};

async function generateOutreachSuggestions(neglectedContacts) {
  const suggestions = neglectedContacts.map(contact => {
    const urgency = (1 - contact.healthScore)
      * (CATEGORY_WEIGHT[contact.category] || 0.3);

    const lastDirection = contact.lastContactDirection;
    const theyReachedOut = lastDirection === 'inbound';

    return {
      contactId: contact.id,
      contactName: contact.name,
      urgency: Math.round(urgency * 100) / 100,
      daysSinceContact: contact.daysSinceContact,
      reason: theyReachedOut
        ? `${contact.name} reached out ${contact.daysSinceContact} days ago — no reply recorded`
        : `No communication with ${contact.name} in ${contact.daysSinceContact} days`,
      suggestedAction: theyReachedOut ? 'reply' : 'check_in',
      category: contact.category,
    };
  });

  return suggestions.sort((a, b) => b.urgency - a.urgency);
}
```

Unreplied inbound messages rank highest — someone reached out and got silence, which is worse than mutual neglect.

### Periodic Tick Integration

The health scanner integrates into the agent's background processing loop, running on a configurable interval:

```javascript
// lib/relationship-health.js

function startHealthMonitor({ intervalMs = 6 * 60 * 60 * 1000, onSuggestions } = {}) {
  async function tick() {
    const neglected = await scanForNeglectedContacts();
    if (neglected.length > 0) {
      const suggestions = await generateOutreachSuggestions(neglected);
      if (onSuggestions) {
        onSuggestions(suggestions);
      }
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick(); // Run immediately on start

  return { stop: () => clearInterval(timer) };
}
```

The default interval of 6 hours strikes a balance — frequent enough to catch neglect within a day, infrequent enough to not waste cycles on a slowly-changing dataset.

## Implications

- Defining "healthy" communication frequency is inherently subjective. Default cadences per category are a starting point, but per-contact overrides are essential for accuracy. A quarterly client who prefers monthly updates will generate false neglect alerts without custom cadence settings.
- There is a real risk of nagging. If the agent surfaces 15 neglected contacts every scan, the user will start ignoring suggestions entirely. Capping suggestions per scan (e.g., top 5 by urgency) and suppressing recently-surfaced contacts prevents alert fatigue.
- Privacy considerations are non-trivial. Tracking communication frequency, direction, and sentiment creates a detailed behavioral profile. This data should be treated as sensitive, stored with appropriate access controls, and never exposed to external systems without explicit consent.
- The cold-start problem affects new contacts. With no interaction history, a freshly added contact has no `lastContactAt` — it will immediately appear as neglected. Using `createdAt` as a fallback for new contacts (grace period equal to one cadence cycle) prevents this.
- Sentiment tracking via a single numeric trend is lossy. A contact who alternates between very positive and very negative interactions will show a "neutral" trend, masking volatility. For high-value contacts, discrete sentiment logging per interaction may be warranted.
- The decay function treats all silence equally — a planned two-month hiatus from a client (parental leave, sabbatical) looks identical to actual neglect. Pause/snooze functionality per contact prevents false alarms during known gaps.

## Code Example

```javascript
// Full integration: periodic health monitoring with Riley's cognitive loop

const health = require('./lib/relationship-health');

// Record interactions as they happen (called from message processing pipeline)
await health.recordInteraction(contactId, {
  direction: 'outbound',
  channel: 'email',
  sentiment: 0.8,    // positive interaction
});

// Start background monitoring
const monitor = health.startHealthMonitor({
  intervalMs: 6 * 60 * 60 * 1000,  // every 6 hours
  onSuggestions: (suggestions) => {
    // Top 5 most urgent, feed into the agent's next reasoning cycle
    const top = suggestions.slice(0, 5);
    for (const s of top) {
      console.log(`[health] ${s.reason} (urgency: ${s.urgency})`);
      // → "[health] Alex reached out 12 days ago — no reply recorded (urgency: 0.87)"
      // → "[health] No communication with Jordan in 45 days (urgency: 0.63)"
    }
    // Pass to cognitive loop for autonomous action consideration
    events.emit('relationship.neglect_detected', { suggestions: top });
  },
});

// Query a specific contact's health on demand
const contactHealth = await health.getContactHealth('contact_abc');
// → { name: 'Alex', healthScore: 0.18, status: 'neglected', daysSinceContact: 41, ... }

// Clean shutdown
monitor.stop();
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Anticipation Engine](./anticipation-engine.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
