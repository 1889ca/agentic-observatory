# Session Episode Tracking

> Groups conversation messages into logical episodes within a session, enabling context reconstruction and per-session entity tracking across restarts.

## Problem

Long-running sessions accumulate context that becomes unwieldy to manage as a flat message list. Without episode boundaries, the system cannot distinguish a topic shift from a continuation, cannot efficiently reconstruct partial context, and loses the ability to answer "what were we talking about before this digression?" After a restart, session state is gone entirely — the system treats every new session as if it has no history.

## Context

This pattern applies when a conversational agent maintains sessions that:
- Span multiple topics or task threads within a single user relationship
- Must survive process restarts without losing conversational continuity
- Need to track which entities (people, projects, tasks) were discussed and when
- Require efficient partial context loading (load only the relevant episode, not the entire history)

## Solution

Session state is never held purely in memory. Every message is written to the database with episode metadata at write time. Episodes are logical units — a coherent thread of conversation around a topic — detected by topic shift signals or time gaps between messages.

On demand (at session start, after restart, or when assembling context), the system replays episode records from the database to rebuild full session state. Entity references discovered during a session are indexed against the episode, so the system can answer "which episodes involved Project X?" without scanning full message bodies.

**Episode boundary detection** uses two signals:
1. Time gap — a configurable silence threshold (e.g., 30 minutes) automatically closes the current episode and opens a new one on next message.
2. Topic shift — embedding distance or keyword divergence from the current episode's centroid triggers a soft boundary.

**Session reconstruction** replays episodes in order, restoring entity refs and message counts. Only episodes relevant to the current task need to be loaded, keeping context windows manageable.

```js
// Session reconstruction from DB
async function reconstructSession(sessionId) {
  const episodes = await db.episodes
    .where({ session_id: sessionId })
    .orderBy('started_at', 'asc')
    .all();

  return episodes.reduce((state, episode) => {
    state.episodes.push({
      id: episode.id,
      startedAt: episode.started_at,
      messageCount: episode.message_count,
      entityRefs: episode.entity_refs,   // e.g. ['contact:john', 'project:atlas']
      summary: episode.summary,
    });
    state.entityIndex.merge(episode.entity_refs);
    return state;
  }, { episodes: [], entityIndex: new EntityIndex() });
}
```

**Episode metadata** stored per episode:
- `started_at` — timestamp of first message in episode
- `message_count` — number of messages in episode
- `entity_refs` — array of entity IDs referenced during the episode
- `summary` — optional LLM-generated summary for long-episode compression

**Entity tracking** per session maintains an inverted index: entity ID → list of episode IDs where that entity appeared. This enables targeted context retrieval ("load all episodes about John") without full message replay.

## Implications

- Session state can always be rebuilt from the database; in-memory state is a cache, not the source of truth.
- Episode granularity is a tuning parameter — too fine creates overhead; too coarse defeats the purpose of scoped retrieval.
- Episode boundary detection is heuristic and will occasionally split or merge incorrectly; downstream consumers should treat episode boundaries as soft hints, not hard semantic guarantees.
- Entity indexing at write time adds latency per message but enables sub-linear context retrieval at read time.
- Long sessions with many episodes can be compressed: old episodes are summarized and their raw messages dropped, keeping the index intact.
- Enabling session reconstruction across restarts requires that all message writes be synchronous to the DB before acknowledging to the caller.

## Code Example

```js
// Detecting episode boundaries and assigning messages
function assignEpisode(session, message) {
  const current = session.currentEpisode;
  const gapMs = message.timestamp - current.lastMessageAt;
  const topicDrift = computeTopicDrift(current.centroid, message.embedding);

  const newEpisodeTrigger =
    gapMs > SESSION_GAP_THRESHOLD_MS || topicDrift > TOPIC_DRIFT_THRESHOLD;

  if (newEpisodeTrigger) {
    current.closedAt = message.timestamp;
    db.episodes.update(current.id, { closed_at: current.closedAt });

    const next = db.episodes.create({
      session_id: session.id,
      started_at: message.timestamp,
      entity_refs: [],
      message_count: 0,
    });
    session.currentEpisode = next;
  }

  session.currentEpisode.message_count += 1;
  session.currentEpisode.lastMessageAt = message.timestamp;

  const entities = extractEntityRefs(message);
  if (entities.length) {
    session.currentEpisode.entity_refs.push(...entities);
    db.episodes.update(session.currentEpisode.id, {
      entity_refs: session.currentEpisode.entity_refs,
      message_count: session.currentEpisode.message_count,
    });
  }

  return session.currentEpisode;
}
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Request-Scoped Context Propagation](./request-scoped-context.md)
