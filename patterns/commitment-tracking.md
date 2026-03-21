# Commitment Tracking

> Monitoring and escalation of explicitly created commitments, with progressive overdue notifications to close the loop on stated intentions.

## Problem

Agents and humans make commitments constantly — "I'll send that report by Friday", "Let's deploy after lunch", "I'll look into that bug". These commitments live only in conversation history, which nobody re-reads. Without tracking, commitments silently expire. The agent says it will do something, doesn't, and nobody notices until trust has already eroded.

The challenge isn't just recording commitments — it's knowing when they've gone stale. A commitment made three days ago with no follow-up is a different problem than one made an hour ago. The system needs to apply increasing pressure as commitments age past their due dates, without becoming a relentless nag about items that were simply forgotten to be marked done.

## Context

- A conversational AI agent that makes promises during interactions (task completion, follow-ups, scheduled actions)
- Commitments are created explicitly — either by the agent flagging its own promises or by the user marking something as a commitment
- No automated extraction pipeline exists; the system tracks commitments it's told about, not ones it infers
- Integration with a document storage system where commitments live alongside other records
- Progressive escalation is needed so that forgotten commitments don't silently disappear

## Solution

### Commitment Storage

Commitments are stored as documents in the existing documents table, distinguished by an `isCommitment` flag rather than living in a dedicated commitments table. This piggybacks on the document system's existing metadata, search, and lifecycle infrastructure:

```javascript
// Creating a commitment is just creating a document with the flag set
async function createCommitment({ action, owner, dueAt, source }) {
  return db.query(`
    INSERT INTO documents (content, metadata, created_at)
    VALUES ($1, $2, NOW())
    RETURNING *
  `, [
    action,
    JSON.stringify({ isCommitment: true, owner, dueAt, source, status: 'pending' }),
  ]);
}
```

### Monitoring: Active and Overdue Queries

The tracking system provides two core queries — active commitments and overdue commitments. These are the foundation for both user-facing status checks and the escalation system:

```javascript
// lib/commitments.js
async function getActive() {
  return db.query(`
    SELECT * FROM documents
    WHERE metadata->>'isCommitment' = 'true'
      AND metadata->>'status' = 'pending'
    ORDER BY (metadata->>'dueAt')::timestamptz ASC
  `);
}

async function getOverdue() {
  return db.query(`
    SELECT * FROM documents
    WHERE metadata->>'isCommitment' = 'true'
      AND metadata->>'status' = 'pending'
      AND (metadata->>'dueAt')::timestamptz < NOW()
    ORDER BY (metadata->>'dueAt')::timestamptz ASC
  `);
}
```

### Progressive Escalation

Overdue commitments escalate through three levels based on how long they've been past due. The escalation level drives notification priority and frequency:

```javascript
// lib/commitments.js
function getEscalationLevel(commitment) {
  const dueAt = new Date(commitment.metadata.dueAt);
  const hoursOverdue = (Date.now() - dueAt) / (1000 * 60 * 60);

  if (hoursOverdue < 2) return 1;   // Gentle reminder
  if (hoursOverdue < 24) return 2;  // Elevated — needs attention
  return 3;                          // Critical — something was dropped
}

async function escalateOverdue() {
  const overdue = await getOverdue();

  for (const commitment of overdue.rows) {
    const level = getEscalationLevel(commitment);

    if (level === 1) {
      await notify(commitment.metadata.owner, {
        type: 'commitment_reminder',
        message: `Heads up — you committed to: "${commitment.content}" (due ${timeAgo(commitment.metadata.dueAt)})`,
        priority: 'low',
      });
    } else if (level === 2) {
      await notify(commitment.metadata.owner, {
        type: 'commitment_overdue',
        message: `Overdue: "${commitment.content}" — due ${timeAgo(commitment.metadata.dueAt)}. Reschedule or dismiss?`,
        priority: 'medium',
      });
    } else {
      await notify(commitment.metadata.owner, {
        type: 'commitment_critical',
        message: `Dropped commitment: "${commitment.content}" — ${timeAgo(commitment.metadata.dueAt)} overdue. This needs resolution.`,
        priority: 'high',
      });
    }
  }
}
```

## Implications

- **This is a partial implementation.** The system tracks and escalates commitments but does not automatically extract them from conversation. Commitments must be explicitly created — either by the agent recognizing its own promises and calling `createCommitment()`, or by the user flagging something. This means commitments can still slip through if nobody thinks to record them.
- **Document-flag storage is pragmatic but queryable.** Storing commitments as documents with an `isCommitment` flag avoids schema migration and leverages existing document infrastructure. The trade-off is that commitment-specific queries rely on JSON metadata filtering rather than dedicated indexed columns, which could slow down at scale.
- **Progressive escalation prevents notification fatigue.** Three escalation levels mean a commitment that's 30 minutes overdue gets a gentle nudge, not an alarm. This is important — most "overdue" commitments are just slightly late, and aggressive escalation would train users to ignore all notifications.
- **No fulfillment detection exists.** The system cannot automatically determine whether a commitment was satisfied. Commitments must be manually marked as fulfilled or dismissed. This is the biggest gap — without fulfillment detection, the system is essentially a deadline tracker with escalating reminders.
- **Escalation without extraction inverts the expected workflow.** Most commitment tracking systems start with "detect the commitment" and end with "remind if overdue." This implementation only has the tail end, which means the quality of tracking depends entirely on the discipline of whoever creates the commitment records.

## Code Example

```javascript
// Integration: commitment monitoring in the cognitive loop or cron
// lib/commitments.js

async function commitmentCycle() {
  // Escalate anything overdue
  await escalateOverdue();

  // Log current state for observability
  const active = await getActive();
  const overdue = await getOverdue();

  logger.info('Commitment cycle complete', {
    active: active.rows.length,
    overdue: overdue.rows.length,
  });
}

// Creating a commitment explicitly (e.g., agent self-reporting)
await createCommitment({
  action: 'Deploy the hotfix to production',
  owner: 'agent',
  dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
  source: 'conversation',
});
```

## Related Patterns

- [Anticipation Engine](./anticipation-engine.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
