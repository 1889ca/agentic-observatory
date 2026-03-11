# Session Consolidation and Memory

> Periodic summarization and narrative storage to maintain continuity across AI sessions without context collapse.

## Problem

Long-running AI orchestrators accumulate conversation history that eventually exceeds context windows. Naive approaches either truncate (losing important context) or summarize too aggressively (losing nuance). The orchestrator needs to preserve what matters — decisions made, emotional trajectory, key facts — while resetting its working memory to prevent degradation. And when a new session starts cold, it needs to orient itself without re-discovering everything from scratch.

## Context

- An orchestrator running continuous sessions over hours or days
- Conversation history growing to hundreds of messages
- Multiple topics, decisions, and emotional states within a single session
- Need for continuity across session resets and restarts
- Cold starts where no prior session state exists in memory

## Solution

### Time-Triggered Consolidation

Rather than consolidating on every message, use dual triggers:
- **Message count threshold** (e.g., 50 messages since last consolidation)
- **Time threshold** (e.g., 2 hours since last consolidation)

Whichever fires first initiates the consolidation cycle.

```javascript
function shouldConsolidate(session) {
  const messagesSince = session.messageCount - session.lastConsolidationAt;
  const timeSince = Date.now() - session.lastConsolidationTime;
  return messagesSince >= 50 || timeSince >= 2 * 60 * 60 * 1000;
}
```

### Three-Phase Consolidation Cycle

**Phase 1: Summarize** — Feed recent conversation to the AI with a structured prompt requesting: key events, decisions made, emotional trajectory, and unresolved threads.

**Phase 2: Store** — Extract facts as narrative memories with metadata (confidence score, source tags, timestamps). Store these in a searchable memory system with embeddings.

**Phase 3: Reset** — Clear the session's conversation history and start fresh. The next interaction begins with an orientation briefing rather than raw history.

### Orientation Briefings

On cold start (no active session), inject a briefing assembled from:
- Latest consolidation summary
- Today's important activity (filtered by significance)
- Pinned/high-priority memories
- Pending tasks from the kanban board
- Recent project notes

This gives the fresh session rich context without carrying forward raw conversation.

```javascript
function buildOrientation() {
  const briefing = getLatestBriefing();       // from last consolidation
  const activity = getTodayActivity();         // filtered by importance
  const pinned = getPinnedMemories();          // always-relevant context
  const tasks = getPendingTasks();             // what needs doing
  return formatOrientationPrompt(briefing, activity, pinned, tasks);
}
```

### Valence Tracking

Each AI response is tagged with a sentiment marker (`VALENCE: {type}:{score}`). These are aggregated during consolidation to track emotional trajectory — enabling the system to understand not just what happened, but how the session "felt." This informs future prioritization and interaction style.

## Implications

- Consolidation is lossy by design — some conversational nuance is inevitably discarded
- The quality of stored memories depends entirely on the AI's summarization accuracy
- Valence tracking adds affective dimension but may not be reliable across all interaction types
- Time-triggered consolidation can interrupt natural conversation flow
- Cold-start orientation may include stale information if memories aren't pruned
- Session reset forces loss of any context not explicitly captured during summarization

## Code Example

```javascript
async function consolidate(session) {
  // Phase 1: Summarize
  const summary = await dispatch({
    type: 'consolidation',
    prompt: `Summarize this session: key events, decisions, emotional arc, open threads.`,
    context: session.recentMessages
  });

  // Phase 2: Store narrative memories
  const facts = extractFacts(summary);
  for (const fact of facts) {
    await storeMemory({
      content: fact.text,
      confidence: fact.confidence,
      source: `consolidation:${session.id}`,
      timestamp: Date.now()
    });
  }

  // Phase 3: Reset session
  await saveBriefing(session.id, summary);
  session.messageCount = 0;
  session.lastConsolidationTime = Date.now();
  await resetSession(session.id); // clears conversation, forces fresh context
}
```

## Related Patterns

- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
