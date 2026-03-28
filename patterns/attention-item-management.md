# Attention Item Management

> DB-backed attention items with integer priorities, domain/itemType classification, Hue light alerts for high-priority items, and source-based deduplication and resolution.

## Problem

An AI agent managing tasks, messages, and events generates a stream of items that need human attention. Not everything is equally urgent, and not everything should be surfaced immediately. Without a dedicated attention layer, the agent either overwhelms the user with every item (notification fatigue) or silently drops things that needed follow-up. Tasks and attention items are different: a task is work to be done; an attention item is something the user needs to know about or decide on.

## Context

- An orchestrator managing multiple input domains (email, calendar, GitHub, system alerts, finances)
- Users have limited attention bandwidth -- surfacing everything is as bad as surfacing nothing
- Items come from diverse sources with different urgency profiles
- Some items can be snoozed and resurfaced later
- Some items resolve themselves (e.g., a PR that gets merged resolves its review attention item)
- The system needs deduplication -- the same source event shouldn't create multiple attention items
- Physical notification via smart home devices (Hue lights) adds urgency for critical items

## Solution

### DB-Backed Attention Items

Attention items are stored in a PostgreSQL `attention_items` table with rich classification. Each item has a `domain` (email, github, finance, system) and `itemType` (review, deadline, alert) for structured filtering:

```javascript
// lib/orchestrator/attention.js
async function createAttentionItem({
  domain,        // 'email', 'github', 'finance', 'system'
  itemType,      // 'review', 'deadline', 'alert', 'follow_up'
  title,
  description = null,
  priority = 2,  // 1=low, 2=medium, 3=high, 4=critical
  urgency = 'normal',
  sourceType = null,
  sourceId = null,
  sourceUrl = null,
  metadata = {},
  tenantId = null,
}) {
  tenantId = tenantId || 1;

  // Deduplicate: check for existing active item from same source
  if (sourceType && sourceId) {
    const existing = await getAttentionItem(sourceType, sourceId, tenantId);
    if (existing && existing.status === 'active') {
      return updateAttentionItem(existing.id, {
        title, description, priority, urgency,
        metadata: { ...existing.metadata, ...metadata },
      });
    }
  }

  // Normalize priority to integer (LLM may send string like 'low')
  const normalizedPriority = normalizePriority(priority);

  const result = await query(
    `INSERT INTO attention_items
    (tenant_id, domain, item_type, title, description, priority, urgency,
     source_type, source_id, source_url, context_snapshot, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [tenantId, domain, itemType, title, description, normalizedPriority,
     urgency, sourceType, sourceId, sourceUrl,
     JSON.stringify(await contextBehaviors.getActiveBehaviors()),
     JSON.stringify(metadata)]
  );

  const item = result[0];

  // Flash Hue light for high-priority items
  if (normalizedPriority >= 3 && hueProxy.isAvailable()) {
    const enabledPref = await preferences.get('notification', 'hue_flash_attention');
    if (enabledPref?.value !== false) {
      hueProxy.sendAlert({ times: 3, lightId: 'default' });
    }
  }

  // Emit event for other systems
  events.emit('attention.created', {
    id: item.id, domain, itemType, title, priority, urgency,
  });

  return item;
}
```

### Integer Priority System

Priorities are integers 1-4 with a normalization function that handles both numeric and string inputs, since LLM-generated tool calls often pass strings:

```javascript
function normalizePriority(priority) {
  if (typeof priority === 'number') return Math.max(1, Math.min(4, priority));
  if (typeof priority === 'string') {
    const map = {
      low: 1,
      medium: 2,
      normal: 2,
      high: 3,
      critical: 4,
      urgent: 4,
    };
    return map[priority.toLowerCase()] || 2;
  }
  return 2;
}
```

### Source-Based Deduplication and Resolution

Items track their source with `sourceType` and `sourceId`, enabling both deduplication on creation and resolution when the source event is handled:

```javascript
// Resolve by source -- called when the underlying event is handled
async function resolveBySource(sourceType, sourceId, resolutionType = 'auto_resolved') {
  const result = await query(
    `UPDATE attention_items
     SET status = 'resolved', resolved_at = NOW(),
         resolution_type = $4, updated_at = NOW()
     WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 AND status = 'active'
     RETURNING *`,
    [tenantId, sourceType, sourceId, resolutionType]
  );
  return result[0];
}

// Example: when a PR is merged, resolve its review attention item
await resolveBySource('github_pr', 'repo/123', 'auto_resolved');
```

### Notification Tracking

Each item tracks notification history to prevent re-notifying about the same item:

```javascript
async function markNotified(id) {
  return query(
    `UPDATE attention_items
     SET last_notified_at = NOW(),
         first_notified_at = COALESCE(first_notified_at, NOW()),
         notification_count = notification_count + 1,
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
}
```

### Snooze with Auto-Unsnooze

Items can be snoozed with a specific wake-up time. A maintenance job periodically checks for expired snoozes:

```javascript
async function snoozeAttentionItem(id, until) {
  return query(
    `UPDATE attention_items
     SET status = 'snoozed', snoozed_until = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, until]
  );
}

// Called periodically by a maintenance job
async function unsnoozeExpired() {
  return query(
    `UPDATE attention_items
     SET status = 'active', snoozed_until = NULL, updated_at = NOW()
     WHERE status = 'snoozed' AND snoozed_until <= NOW()
     RETURNING *`
  );
}
```

### Filtered Retrieval

Active items are retrieved with optional domain and type filters, ordered by priority descending:

```javascript
async function getActiveAttentionItems({ domain = null, itemType = null, limit = 50 } = {}) {
  let sql = `
    SELECT * FROM attention_items
    WHERE tenant_id = $1 AND status = 'active'
  `;
  const params = [tenantId];

  if (domain) { sql += ` AND domain = $${++paramIdx}`; params.push(domain); }
  if (itemType) { sql += ` AND item_type = $${++paramIdx}`; params.push(itemType); }

  sql += ` ORDER BY priority DESC, created_at ASC LIMIT $${++paramIdx}`;
  params.push(limit);

  return query(sql, params);
}
```

### Fuzzy Title Resolution

When a user references an attention item by description rather than ID, fuzzy matching finds the right item:

```javascript
async function resolveAttentionItemByTitle(searchQuery) {
  const items = await query(
    `SELECT * FROM attention_items
     WHERE tenant_id = $1 AND status = 'active'
     ORDER BY priority DESC, created_at ASC`,
    [tenantId]
  );

  const queryLower = searchQuery.toLowerCase();

  // Exact match first
  const exact = items.find(i => i.title.toLowerCase() === queryLower);
  if (exact) return exact;

  // Partial match -- query contained in title or vice versa
  const partial = items.filter(i => {
    const titleLower = i.title.toLowerCase();
    return titleLower.includes(queryLower) || queryLower.includes(titleLower);
  });

  return partial.length === 1 ? partial[0] : null; // Null if ambiguous
}
```

## Implications

- DB-backed storage means attention items survive restarts and are queryable for analytics, unlike in-memory priority queues
- Integer priorities (1-4) with string normalization handle the mismatch between human input ("high") and structured storage -- the LLM can pass either format
- Source-based deduplication prevents the common problem of multiple attention items for the same underlying event (e.g., repeated calendar reminders)
- Hue light integration adds physical-world urgency for critical items, but is preference-controlled so users can opt out
- The `context_snapshot` field captures situational context at creation time, providing debugging context for why an item was created with a particular priority
- Domain/itemType classification enables filtered views -- "show me all GitHub attention items" or "what finance items need attention"
- Resolution tracking (`resolution_type`, `resolution_note`) creates an audit trail of how items were handled
- Event emission on creation (`attention.created`) enables other systems (like the briefing generator) to incorporate attention items without polling
- Fuzzy title resolution returns null on ambiguous matches rather than guessing, preventing incorrect auto-resolution

## Code Example

```javascript
const attention = require('./lib/orchestrator/attention');

// Create a high-priority attention item (flashes Hue light)
await attention.createAttentionItem({
  domain: 'github',
  itemType: 'review',
  title: 'PR #42 needs review - blocking deploy',
  description: 'Alex requested review 2 hours ago',
  priority: 3,                    // high -- triggers Hue flash
  sourceType: 'github_pr',
  sourceId: 'riley/42',
  sourceUrl: 'https://github.com/org/riley/pull/42',
  metadata: { author: 'alex', repo: 'riley' },
});

// Get all active items for a domain
const githubItems = await attention.getActiveAttentionItems({ domain: 'github' });

// Snooze for 1 hour
await attention.snoozeAttentionItem(itemId, new Date(Date.now() + 3600_000));

// Auto-resolve when PR is merged
await attention.resolveBySource('github_pr', 'riley/42', 'auto_resolved');

// Resolve with a note
await attention.resolveAttentionItem(itemId, 'user_action', 'Reviewed and approved');
```

## Related Patterns

- [Unified Event System](./unified-event-system.md)
- [Situation Detection and Context Awareness](./situation-detection-and-context-awareness.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
