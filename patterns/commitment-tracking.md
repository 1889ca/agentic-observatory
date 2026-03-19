# Commitment Tracking and Extraction

> Automatic detection of commitments from natural language conversations, with task creation, fulfillment tracking, and overdue escalation to close the loop on stated intentions.

## Problem

Agents and humans make commitments in natural language constantly — "I'll send that report by Friday", "Let's deploy after lunch", "I'll look into that bug". These commitments live only in conversation history, which nobody re-reads. Without extraction and tracking, commitments silently expire. The agent says it will do something, doesn't, and nobody notices until trust has already eroded. Multiply this across dozens of daily interactions and the agent becomes the colleague who always says "yeah, I'll get to that" and never does.

The problem compounds with multi-party conversations. When an agent commits to actions on behalf of a user ("I'll set up that meeting with Sarah"), the user assumes it's handled. There's no mechanism to verify the commitment was fulfilled, no reminder when it wasn't, and no audit trail showing what was promised versus what was delivered.

## Context

- A conversational AI agent that makes promises during interactions (task completion, follow-ups, scheduled actions)
- Multiple conversation channels where commitments can be made (chat, email, Slack, voice transcripts)
- Need to close the loop on stated intentions without requiring users to manually create tasks
- Integration with an existing task management system for tracking and escalation
- Commitments vary in specificity — some have explicit deadlines ("by 3pm"), others are vague ("soon", "later today")
- The agent should be accountable for its own commitments, not just track human ones

## Solution

### Commitment Extraction

Every outgoing agent message and incoming human message passes through a commitment extractor. The first pass uses regex patterns to catch common commitment language, then an LLM pass disambiguates and enriches:

```javascript
// lib/commitments.js
const COMMITMENT_PATTERNS = [
  { pattern: /\bI'?ll\s+(?!just\b)(.+?)(?:\.|,|$)/gi, strength: 'strong' },
  { pattern: /\bI'?m going to\s+(.+?)(?:\.|,|$)/gi, strength: 'strong' },
  { pattern: /\bLet(?:'s| us)\s+(.+?)(?:\.|,|$)/gi, strength: 'moderate' },
  { pattern: /\bI(?:'ll| will) make sure\s+(.+?)(?:\.|,|$)/gi, strength: 'strong' },
  { pattern: /\bI can (?:do|handle|take care of)\s+(.+?)(?:\.|,|$)/gi, strength: 'moderate' },
  { pattern: /\bWe should\s+(.+?)(?:\.|,|$)/gi, strength: 'weak' },
];

function extractCandidates(message) {
  const candidates = [];

  for (const { pattern, strength } of COMMITMENT_PATTERNS) {
    let match;
    while ((match = pattern.exec(message)) !== null) {
      candidates.push({
        raw: match[0].trim(),
        action: match[1].trim(),
        strength,
        position: match.index,
      });
    }
  }

  return candidates;
}
```

Regex alone produces too many false positives — "I'll think about it" is not a commitment, "I'll deploy the hotfix" is. An LLM pass filters and enriches the candidates:

```javascript
// lib/commitments.js
async function classifyCommitments(candidates, conversationContext) {
  if (candidates.length === 0) return [];

  const result = await llm.structured({
    prompt: `Given these potential commitments extracted from a conversation,
classify each as a real commitment or not. For real commitments, extract:
- action: what specifically was promised
- owner: who made the commitment (agent or human)
- deadline: explicit or inferred deadline (null if unclear)
- confidence: 0-1 how confident this is a real commitment

Candidates: ${JSON.stringify(candidates)}
Conversation context: ${conversationContext}`,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          isCommitment: { type: 'boolean' },
          action: { type: 'string' },
          owner: { enum: ['agent', 'human'] },
          deadline: { type: 'string', nullable: true },
          confidence: { type: 'number' },
        },
      },
    },
  });

  return result.filter(c => c.isCommitment && c.confidence > 0.6);
}
```

### Commitment Lifecycle

Extracted commitments flow through a state machine: `extracted → pending → fulfilled | overdue | dismissed`.

```
extracted ──→ pending ──→ fulfilled
                │
                ├──→ overdue ──→ escalated
                │
                └──→ dismissed (false positive)
```

Each commitment is stored with enough context to verify fulfillment later:

```javascript
// lib/commitments.js
async function createCommitment({ action, owner, deadline, source, conversationId }) {
  const dueAt = deadline
    ? parseDeadline(deadline)
    : inferDeadline(action);

  return db.query(`
    INSERT INTO commitments (action, owner, due_at, status, source, conversation_id, created_at)
    VALUES ($1, $2, $3, 'pending', $4, $5, NOW())
    RETURNING *
  `, [action, owner, dueAt, source, conversationId]);
}

function inferDeadline(action) {
  // Time-suggestive language gets shorter deadlines
  if (/\b(now|right away|immediately)\b/i.test(action)) {
    return new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  }
  if (/\b(today|this afternoon|this morning)\b/i.test(action)) {
    return endOfDay();
  }
  if (/\b(tomorrow)\b/i.test(action)) {
    return endOfDay(addDays(new Date(), 1));
  }
  if (/\b(this week)\b/i.test(action)) {
    return endOfWeek();
  }
  // No temporal signal — default to 24 hours
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}
```

### Fulfillment Detection

A periodic check runs against pending commitments, comparing them to completed actions in the task system. Fulfillment detection uses both exact matching (task IDs linked to commitments) and semantic matching (LLM comparison of commitment text against recent activity):

```javascript
// lib/task-lifecycle.js
async function checkFulfillment() {
  const pending = await db.query(`
    SELECT * FROM commitments
    WHERE status = 'pending'
    ORDER BY due_at ASC
  `);

  for (const commitment of pending.rows) {
    // Check 1: Was a linked task completed?
    if (commitment.linked_task_id) {
      const task = await getTask(commitment.linked_task_id);
      if (task?.status === 'completed') {
        await markFulfilled(commitment.id, { method: 'task_link', taskId: task.id });
        continue;
      }
    }

    // Check 2: Semantic match against recent completed actions
    const recentActions = await getRecentActions(commitment.owner, {
      since: commitment.created_at,
      limit: 50,
    });

    const match = await llm.structured({
      prompt: `Was this commitment fulfilled by any of these actions?
Commitment: "${commitment.action}" (made ${commitment.created_at})
Recent actions: ${JSON.stringify(recentActions.map(a => a.summary))}`,
      schema: {
        type: 'object',
        properties: {
          fulfilled: { type: 'boolean' },
          matchedAction: { type: 'string', nullable: true },
          confidence: { type: 'number' },
        },
      },
    });

    if (match.fulfilled && match.confidence > 0.75) {
      await markFulfilled(commitment.id, {
        method: 'semantic_match',
        matchedAction: match.matchedAction,
        confidence: match.confidence,
      });
    }
  }
}
```

### Overdue Escalation

Commitments that pass their deadline without fulfillment escalate through the notification system. Escalation is progressive — a gentle reminder first, then a more urgent notification if still unresolved:

```javascript
// lib/commitments.js
async function escalateOverdue() {
  const overdue = await db.query(`
    SELECT * FROM commitments
    WHERE status = 'pending' AND due_at < NOW()
    ORDER BY due_at ASC
  `);

  for (const commitment of overdue.rows) {
    const hoursOverdue = (Date.now() - new Date(commitment.due_at)) / (1000 * 60 * 60);

    if (hoursOverdue < 2 && !commitment.first_reminder_at) {
      // Gentle nudge
      await notify(commitment.owner, {
        type: 'commitment_reminder',
        message: `Heads up — you committed to: "${commitment.action}" (due ${timeAgo(commitment.due_at)})`,
        priority: 'low',
      });
      await db.query(`UPDATE commitments SET first_reminder_at = NOW() WHERE id = $1`, [commitment.id]);

    } else if (hoursOverdue >= 2) {
      // Mark overdue, escalate
      await db.query(`UPDATE commitments SET status = 'overdue' WHERE id = $1`, [commitment.id]);
      await notify(commitment.owner, {
        type: 'commitment_overdue',
        message: `Overdue commitment: "${commitment.action}" — due ${timeAgo(commitment.due_at)}. Should this be rescheduled or dismissed?`,
        priority: 'medium',
        actions: ['reschedule', 'dismiss', 'mark_done'],
      });
    }
  }
}
```

## Implications

- **False positives are the primary risk.** Not every "I'll" is a commitment — "I'll think about it" and "I'll be honest" are conversational filler. The confidence threshold (0.6) is deliberately permissive; production systems will need tuning per domain. Too aggressive and the system becomes a nag; too conservative and real commitments slip through.
- **Due date inference is inherently fuzzy.** "After lunch" means different things to different people. The 24-hour default for unspecified deadlines is a compromise — short enough to catch forgotten items, long enough to avoid premature escalation. Vague commitments ("soon", "when I get a chance") are the hardest to deadline and may warrant a separate "soft commitment" category with no escalation.
- **Creates accountability pressure on the agent.** Once the agent knows its commitments are tracked, the system design pressures the agent to either follow through or explicitly revise its commitments. This is the intended behavior — but it also means the agent may become conservative about making commitments, preferring hedged language to avoid tracking.
- **Semantic fulfillment matching is expensive.** Each pending commitment requires an LLM call during the fulfillment check cycle. Batching commitments per check cycle and caching recent actions reduces cost, but this is still the most compute-intensive part of the pipeline.
- **Commitment extraction adds latency to the message path.** Running extraction on every message slows the response pipeline. Running it asynchronously (fire-and-forget after the response is sent) avoids latency but means commitments from the most recent exchange aren't yet tracked if the user immediately asks "what did you commit to?"

## Code Example

```javascript
// Integration: extract commitments from agent responses in the message pipeline
// lib/commitments.js

async function processMessage(message, { role, conversationId }) {
  // Extract commitment candidates via regex
  const candidates = extractCandidates(message);
  if (candidates.length === 0) return;

  // Classify with LLM
  const commitments = await classifyCommitments(candidates, message);

  // Create commitment records
  for (const commitment of commitments) {
    await createCommitment({
      action: commitment.action,
      owner: role === 'assistant' ? 'agent' : 'human',
      deadline: commitment.deadline,
      source: 'conversation',
      conversationId,
    });
  }
}

// Periodic fulfillment and escalation checks (called from cognitive loop or cron)
async function commitmentCycle() {
  await checkFulfillment();
  await escalateOverdue();

  const stats = await db.query(`
    SELECT status, COUNT(*) as count FROM commitments
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY status
  `);
  logger.info('Commitment cycle complete', Object.fromEntries(stats.rows.map(r => [r.status, r.count])));
}
```

## Related Patterns

- [Anticipation Engine](./anticipation-engine.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
