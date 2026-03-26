# Outbound Queue with Backoff

> Retry logic with exponential backoff for outbound message delivery, integrated into the message sending flow rather than a standalone queue class.

## Problem

Direct message sending is synchronous and fragile. Channel APIs fail, rate limit, or timeout unpredictably. Without retry logic, a failed send is a lost message — the orchestrator has no way to recover and the user never gets notified. Scheduled messages (send a reminder at 9am tomorrow) need a completely separate mechanism if there's no durable intermediary, leading to duplicated delivery logic.

## Context

- An AI agent sends messages across multiple channels (Slack, Telegram, email, WhatsApp) with different reliability characteristics
- Channel APIs may be temporarily down, rate-limited, or slow to respond
- Some messages are immediate; others are scheduled for future delivery
- Failed sends must be retried automatically without manual intervention
- The orchestrator needs to fire-and-forget when enqueuing — delivery is the sending flow's problem

## Solution

### Message Storage

Each outbound message is persisted as a record with delivery metadata:

```javascript
// Message record structure
{
  id: 'msg_abc123',
  channel: 'telegram',
  recipient: '12345678',
  content: 'Your daily summary is ready.',
  scheduledFor: new Date('2025-03-15T09:00:00Z'),  // null = immediate
  status: 'pending',       // pending | processing | delivered | failed
  attempts: 0,
  maxRetries: 5,
  nextRetryAt: null,
  lastError: null,
  createdAt: new Date(),
  deliveredAt: null,
}
```

Messages are stored durably — in a database, not just in memory. A server restart shouldn't lose pending messages.

### Delivery with Integrated Retry

Rather than a dedicated `OutboundQueue` class, the backoff and retry logic is integrated into the message sending flow. A processing loop picks up due messages and attempts delivery through the appropriate channel adapter:

```javascript
// Message sending flow with integrated retry
async function processOutboundMessages(store, router, options = {}) {
  const pollInterval = options.pollInterval || 2000;
  const maxRetries = options.maxRetries || 5;

  while (true) {
    const due = await store.findDue(new Date());

    for (const msg of due) {
      await attemptDelivery(store, router, msg, maxRetries);
    }

    await sleep(pollInterval);
  }
}

async function enqueueMessage(store, channel, recipient, content, options = {}) {
  return store.insert({
    id: generateId(),
    channel,
    recipient,
    content,
    scheduledFor: options.scheduledFor || null,
    status: 'pending',
    attempts: 0,
    maxRetries: options.maxRetries || 5,
    nextRetryAt: null,
    lastError: null,
    createdAt: new Date(),
    deliveredAt: null,
  });
}
```

### Exponential Backoff

When a send fails, the message is rescheduled with an exponentially increasing delay. This prevents hammering a channel that's already struggling:

```javascript
async function attemptDelivery(store, router, msg, maxRetries) {
  try {
    await store.update(msg.id, { status: 'processing' });
    await router.route(msg.channel, msg.recipient, msg.content);

    await store.update(msg.id, {
      status: 'delivered',
      deliveredAt: new Date(),
    });
  } catch (err) {
    const attempts = msg.attempts + 1;

    if (attempts >= maxRetries) {
      // Dead letter — exhausted all retries
      await store.update(msg.id, {
        status: 'failed',
        attempts,
        lastError: err.message,
      });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const delayMs = Math.pow(2, attempts) * 1000;
    const nextRetryAt = new Date(Date.now() + delayMs);

    await store.update(msg.id, {
      status: 'pending',
      attempts,
      nextRetryAt,
      lastError: err.message,
    });
  }
}
```

The backoff is per-message, not per-channel. If one message to Telegram fails, other Telegram messages still attempt delivery normally. A channel-wide circuit breaker would be a separate concern.

### Scheduled Delivery

The store's `findDue` query handles both immediate and scheduled messages with a single filter — any message whose `scheduledFor` is null or in the past, and whose `nextRetryAt` is null or in the past:

```javascript
// Store query for due messages
async findDue(now) {
  return this.db.query({
    status: 'pending',
    $or: [
      { scheduledFor: null },
      { scheduledFor: { $lte: now } },
    ],
    $or: [
      { nextRetryAt: null },
      { nextRetryAt: { $lte: now } },
    ],
  });
}
```

This means scheduled messages and retry delays use the same mechanism. A message scheduled for 9am tomorrow sits in the queue with `scheduledFor` set. When the processing loop runs after 9am, it becomes due and gets processed like any other message.

### Metadata Tracking

Every message tracks its own delivery history: attempt count, last error, and timestamps. This makes debugging straightforward — you can query for all failed messages, see why they failed, and how many times they were retried:

```javascript
// Query delivery status
const failed = await store.find({ status: 'failed' });
// [{ id: 'msg_xyz', channel: 'email', attempts: 5,
//    lastError: 'SMTP timeout', createdAt: ... }]

const pending = await store.find({ status: 'pending', attempts: { $gt: 0 } });
// Messages that failed at least once but are still retrying
```

## Implications

- The processing loop adds latency — messages aren't sent inline, they go through a poll cycle. For a 2-second poll interval, worst case adds 2 seconds to delivery
- Backoff prevents hammering failing channels but means a message could take minutes to retry after several failures (5 retries with exponential backoff = up to 32 seconds between last retries)
- Dead letter handling is essential — messages that exhaust retries need monitoring and a manual retry mechanism
- Durable storage is non-negotiable. An in-memory approach loses all pending messages on restart
- The processing loop naturally handles burst absorption — the orchestrator can enqueue 100 messages instantly and they are processed at a sustainable rate
- Scheduled delivery and retry delays share the same time-gate mechanism, keeping the implementation simple

## Code Example

```javascript
// Wiring and usage
processOutboundMessages(messageStore, router, {
  pollInterval: 2000,
  maxRetries: 5,
});

// Immediate send — fire and forget
await enqueueMessage(messageStore, 'slack', '#general', 'Build passed.');

// Scheduled send — deliver tomorrow at 9am
await enqueueMessage(messageStore, 'telegram', chatId, 'Good morning! Here is your daily brief.', {
  scheduledFor: new Date('2025-03-15T09:00:00Z'),
});

// Check delivery health
const stats = await messageStore.aggregate({
  pending: { status: 'pending' },
  failed: { status: 'failed' },
  delivered: { status: 'delivered' },
});
// { pending: 3, failed: 1, delivered: 247 }
```

## Related Patterns

- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Message Processing Pipeline](./message-processing-pipeline.md)
