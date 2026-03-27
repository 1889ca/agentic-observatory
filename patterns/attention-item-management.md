# Attention Item Management

> Track items requiring user attention with snooze, notification throttling, and source-based resolution — a prioritization layer above raw tasks.

## Problem

An AI agent managing tasks, messages, and events generates a stream of items that need human attention. Not everything is equally urgent, and not everything should be surfaced immediately. Without a dedicated attention layer, the agent either overwhelms the user with every item (notification fatigue) or silently drops things that needed follow-up. Tasks and attention items are different: a task is work to be done; an attention item is something the user needs to know about or decide on.

## Context

- An orchestrator managing multiple input sources (messages, calendar events, task deadlines, system alerts)
- Users have limited attention bandwidth — surfacing everything is as bad as surfacing nothing
- Items come from diverse sources with different urgency profiles
- Some items can be snoozed and resurfaced later
- Some items resolve themselves (e.g., a meeting reminder after the meeting passes)
- Notification channels have different costs (Telegram push vs. in-app badge)

## Solution

An attention manager maintains a priority queue of items requiring user awareness. Each item has a source, urgency level, snooze state, and resolution rules. The manager controls when and how items are surfaced, throttling notifications to prevent fatigue while ensuring nothing critical is lost.

### Attention Item Schema

```javascript
// lib/orchestrator/attention.js — illustrative
const URGENCY = {
  critical: 0,  // Surface immediately on any channel
  high: 1,      // Surface within minutes
  normal: 2,    // Surface at next natural interaction
  low: 3,       // Surface only when user asks or during daily digest
};

function createAttentionItem({ source, title, body, urgency, expiresAt, resolveOn }) {
  return {
    id: generateId(),
    source,           // e.g., 'calendar', 'inbox', 'task-deadline', 'system'
    title,
    body,
    urgency: urgency ?? URGENCY.normal,
    status: 'active', // active | snoozed | resolved | expired
    createdAt: new Date(),
    expiresAt,        // Auto-expire (e.g., meeting reminder after meeting ends)
    resolveOn,        // Event that auto-resolves this item
    snoozedUntil: null,
    notifiedAt: null,
  };
}
```

### Notification Throttling

The manager batches non-critical items and applies per-source rate limits to prevent notification storms:

```javascript
const SOURCE_THROTTLE = {
  inbox: { minInterval: 60_000, batchWindow: 300_000 },   // Batch messages over 5 min
  calendar: { minInterval: 0, batchWindow: 0 },            // Always immediate
  'task-deadline': { minInterval: 300_000, batchWindow: 0 },// At most one per 5 min
  system: { minInterval: 60_000, batchWindow: 600_000 },   // Batch system alerts
};

function shouldNotify(item, lastNotification) {
  const throttle = SOURCE_THROTTLE[item.source] ?? SOURCE_THROTTLE.system;

  if (item.urgency === URGENCY.critical) return true;

  if (lastNotification) {
    const elapsed = Date.now() - lastNotification.getTime();
    if (elapsed < throttle.minInterval) return false;
  }

  return true;
}
```

### Snooze and Auto-Resolution

Items can be snoozed to resurface later, or they resolve automatically based on events:

```javascript
function snooze(itemId, until) {
  const item = items.get(itemId);
  item.status = 'snoozed';
  item.snoozedUntil = until;
  scheduleResurface(itemId, until);
}

function checkAutoResolution(event) {
  for (const item of getActive()) {
    // Time-based expiry
    if (item.expiresAt && new Date() > item.expiresAt) {
      resolve(item.id, 'expired');
      continue;
    }

    // Event-based resolution
    if (item.resolveOn && eventMatches(event, item.resolveOn)) {
      resolve(item.id, 'auto-resolved');
    }
  }
}
```

### Digest Generation

Low-urgency items accumulate for periodic digest delivery rather than individual notifications:

```javascript
function generateDigest() {
  const pending = getActive().filter(
    item => item.urgency >= URGENCY.normal && !item.notifiedAt
  );

  if (pending.length === 0) return null;

  const grouped = groupBy(pending, 'source');

  return {
    summary: `${pending.length} items need your attention`,
    sections: Object.entries(grouped).map(([source, items]) => ({
      source,
      count: items.length,
      items: items.map(i => ({ title: i.title, urgency: i.urgency })),
    })),
  };
}
```

## Implications

- Separates "what needs attention" from "what needs doing" — attention items are a prioritization layer above the task system
- Notification throttling prevents fatigue but requires tuning per source — too aggressive and critical items are delayed
- Snooze creates state that must survive restarts — needs persistent storage, not just in-memory
- Auto-resolution based on events means the attention system must subscribe to the event bus, creating a dependency
- Digest mode trades immediacy for batch efficiency — good for low-urgency items, wrong for time-sensitive ones
- The urgency model is static (assigned at creation) — a more sophisticated system could adjust urgency based on elapsed time

## Code Example

```javascript
// Calendar event in 15 minutes — high urgency, auto-resolves after event ends
addAttentionItem({
  source: 'calendar',
  title: 'Meeting with Alex in 15 minutes',
  body: 'Weekly sync — Google Meet link in calendar',
  urgency: URGENCY.high,
  expiresAt: new Date(eventEnd),
  resolveOn: { type: 'calendar:event-ended', eventId: '...' },
});

// Unread message — normal urgency, batched with other messages
addAttentionItem({
  source: 'inbox',
  title: 'New message from Sarah',
  body: 'Re: Project timeline',
  urgency: URGENCY.normal,
});

// User snoozes it
snooze(itemId, new Date(Date.now() + 3600_000)); // Resurface in 1 hour
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Situation Detection and Context Awareness](./situation-detection-and-context-awareness.md)
