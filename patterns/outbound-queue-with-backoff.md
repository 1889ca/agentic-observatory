# Outbound Queue with Backoff

> Async message delivery queue with channel-based routing, scheduled delivery, exponential backoff retry, and metadata tracking.

## Problem

Direct message sending is synchronous and fragile. Channel APIs fail, rate limit, or timeout unpredictably. Without a queue, a failed send is a lost message — the orchestrator has no way to retry and the user never gets notified. Scheduled messages (send a reminder at 9am tomorrow) need a completely separate mechanism if there's no queue, leading to duplicated delivery logic. The combination of unreliable channels, retry needs, and scheduled delivery demands a durable intermediary between "decide to send" and "actually sent."

## Context

- An AI agent sends messages across multiple channels (Slack, Telegram, email, WhatsApp) with different reliability characteristics
- Channel APIs may be temporarily down, rate-limited, or slow to respond
- Some messages are immediate; others are scheduled for future delivery
- Failed sends must be retried automatically without manual intervention
- The orchestrator needs to fire-and-forget when enqueuing — delivery is the queue's problem

## Solution

### Queue Storage

Each enqueued message is a record with delivery metadata:

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

### Processing Loop

The queue runs a polling loop that picks up due messages and dispatches them through the channel adapter:

```javascript
class OutboundQueue {
  constructor(store, router, options = {}) {
    this.store = store;
    this.router = router;
    this.pollInterval = options.pollInterval || 2000;
    this.maxRetries = options.maxRetries || 5;
    this.running = false;
  }

  async enqueue(channel, recipient, content, options = {}) {
    return this.store.insert({
      id: generateId(),
      channel,
      recipient,
      content,
      scheduledFor: options.scheduledFor || null,
      status: 'pending',
      attempts: 0,
      maxRetries: options.maxRetries || this.maxRetries,
      nextRetryAt: null,
      lastError: null,
      createdAt: new Date(),
      deliveredAt: null,
    });
  }

  start() {
    this.running = true;
    this.poll();
  }

  stop() {
    this.running = false;
  }

  async poll() {
    while (this.running) {
      const due = await this.store.findDue(new Date());

      for (const msg of due) {
        await this.process(msg);
      }

      await sleep(this.pollInterval);
    }
  }
}
```

### Exponential Backoff

When a send fails, the message is rescheduled with an exponentially increasing delay. This prevents hammering a channel that's already struggling:

```javascript
async process(msg) {
  try {
    await this.store.update(msg.id, { status: 'processing' });
    await this.router.route(msg.channel, msg.recipient, msg.content);

    await this.store.update(msg.id, {
      status: 'delivered',
      deliveredAt: new Date(),
    });
  } catch (err) {
    const attempts = msg.attempts + 1;

    if (attempts >= msg.maxRetries) {
      // Dead letter — exhausted all retries
      await this.store.update(msg.id, {
        status: 'failed',
        attempts,
        lastError: err.message,
      });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const delayMs = Math.pow(2, attempts) * 1000;
    const nextRetryAt = new Date(Date.now() + delayMs);

    await this.store.update(msg.id, {
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

This means scheduled messages and retry delays use the same mechanism. A message scheduled for 9am tomorrow sits in the queue with `scheduledFor` set. When the poll loop runs after 9am, it becomes due and gets processed like any other message.

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

- The queue adds latency — messages aren't sent inline, they go through a poll cycle. For a 2-second poll interval, worst case adds 2 seconds to delivery
- Backoff prevents hammering failing channels but means a message could take minutes to retry after several failures (5 retries with exponential backoff = up to 32 seconds between last retries)
- Dead letter handling is essential — messages that exhaust retries need monitoring and a manual retry mechanism
- Durable storage is non-negotiable. An in-memory queue loses all pending messages on restart
- The queue naturally handles burst absorption — the orchestrator can enqueue 100 messages instantly and the queue processes them at a sustainable rate
- Scheduled delivery and retry delays share the same time-gate mechanism, keeping the implementation simple

## Code Example

```javascript
// Wiring and usage
const queue = new OutboundQueue(messageStore, router, {
  pollInterval: 2000,
  maxRetries: 5,
});

queue.start();

// Immediate send — fire and forget
await queue.enqueue('slack', '#general', 'Build passed.');

// Scheduled send — deliver tomorrow at 9am
await queue.enqueue('telegram', chatId, 'Good morning! Here is your daily brief.', {
  scheduledFor: new Date('2025-03-15T09:00:00Z'),
});

// Check queue health
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
