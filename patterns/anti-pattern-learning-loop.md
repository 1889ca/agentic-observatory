# Anti-Pattern Learning Loop

> Frequency tracking of recurring protocol errors with automatic injection into the system prompt after a configurable occurrence threshold.

## Problem

LLMs make mistakes when using tools — calling the wrong tool for a task, passing invalid parameters, or misunderstanding a tool's purpose. These mistakes are often systematic: the same error recurs because the model's training data doesn't reflect the orchestrator's specific tool semantics. Without a feedback mechanism, the orchestrator sees the same errors repeatedly, wasting tokens on failed tool calls and degrading user experience.

## Context

- An LLM-powered orchestrator where tool calls are the primary action mechanism
- Protocol errors (LLM misuses a tool) are distinct from transient errors (network issues) and runtime errors (bugs)
- The system prompt is assembled dynamically and can include learned corrections
- Need for automatic learning without human intervention for common, well-understood mistakes
- Must avoid prompt bloat — learned corrections should be bounded and time-limited

## Solution

### Error Signature Creation

When a protocol error occurs, it's reduced to a signature that captures the essential pattern while ignoring incidental details:

```javascript
// learning/anti-patterns.js
function createErrorSignature(toolName, subtype, errorMessage) {
  // Normalize: strip IDs, timestamps, and variable content
  const normalized = errorMessage
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\d{10,}/g, '<timestamp>')
    .substring(0, 200);

  return `${toolName}:${subtype}:${hash(normalized)}`;
}
```

### Frequency Tracking

Each unique error signature is tracked with occurrence count, first seen, and last seen timestamps:

```javascript
async function recordProtocolError(error, triage) {
  const signature = createErrorSignature(triage.toolName, triage.subtype, error.message);

  const existing = await db.query(
    `SELECT * FROM self_improvements WHERE signature = $1`,
    [signature]
  );

  if (existing.length > 0) {
    const record = existing[0];
    const occurrences = (record.occurrences || 1) + 1;

    await db.query(
      `UPDATE self_improvements SET occurrences = $1, last_seen = NOW() WHERE id = $2`,
      [occurrences, record.id]
    );
  } else {
    await db.query(
      `INSERT INTO self_improvements (signature, tool_name, error_message, subtype, occurrences, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, 1, NOW(), NOW())`,
      [signature, triage.toolName, error.message, triage.subtype]
    );
  }
}
```

### Threshold-Based Surfacing

An anti-pattern is only surfaced (injected into the system prompt) after it has been observed at least `ANTI_PATTERN_THRESHOLD` times. This prevents one-off errors from polluting the prompt:

```javascript
const ANTI_PATTERN_THRESHOLD = 3;      // Minimum occurrences to surface
const MAX_ANTI_PATTERNS_IN_PROMPT = 5;  // Cap to prevent prompt bloat
const OCCURRENCE_WINDOW_DAYS = 7;       // Only count recent occurrences

async function getActiveAntiPatterns() {
  const patterns = await db.query(`
    SELECT tool_name, error_message, subtype, occurrences
    FROM self_improvements
    WHERE occurrences >= $1
      AND last_seen > NOW() - INTERVAL '${OCCURRENCE_WINDOW_DAYS} days'
    ORDER BY occurrences DESC
    LIMIT $2
  `, [ANTI_PATTERN_THRESHOLD, MAX_ANTI_PATTERNS_IN_PROMPT]);

  return patterns.map(formatAsCorrection);
}
```

### System Prompt Injection

Active anti-patterns are formatted as corrections and included in context assembly:

```javascript
function formatAsCorrection(pattern) {
  return `AVOID: When using "${pattern.tool_name}", do not ${pattern.subtype}. ` +
    `This error has occurred ${pattern.occurrences} times. ` +
    `Instead: ${pattern.correction || 'check the tool documentation for correct usage.'}`;
}

// In context assembly:
async function assembleContext(message, dispatchType) {
  const antiPatterns = await getActiveAntiPatterns();

  // Anti-patterns get high priority in token budget
  budget.addPart(parts, formatAntiPatterns(antiPatterns), 'anti-patterns');
  // ...
}
```

### In-Memory Cache

Active anti-patterns are cached to avoid hitting the database on every message:

```javascript
let cachedPatterns = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getActiveAntiPatterns() {
  if (cachedPatterns && Date.now() < cacheExpiry) {
    return cachedPatterns;
  }

  cachedPatterns = await fetchFromDb();
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cachedPatterns;
}
```

## Implications

- The threshold of 3 prevents single-occurrence flukes from affecting the prompt while catching genuine systematic errors
- The 7-day occurrence window ensures stale patterns expire naturally — if the error stops recurring, the correction drops out
- Capping at 5 anti-patterns prevents prompt bloat — the most frequent errors get priority
- Signature normalization (stripping IDs and timestamps) groups equivalent errors even when details differ
- This creates a genuine learning loop: error → record → threshold → inject → LLM avoids error → occurrence count plateaus
- The 5-minute cache means a newly learned anti-pattern won't take effect for up to 5 minutes
- No human review step — anti-patterns are auto-injected. This is safe because they're corrections (instructions to avoid something), not new behaviors

## Code Example

```javascript
// Complete anti-pattern learning cycle:

// 1. LLM misuses a tool (e.g., calls 'search' instead of 'entity' for calendar)
const error = new Error('search tool does not support entity type filters');
const triage = {
  category: 'protocol',
  toolName: 'search',
  subtype: 'wrong_tool_for_entity_query',
  learnable: true,
};

// 2. Record the error (non-blocking)
recordProtocolError(error, triage).catch(() => {});

// 3. After 3+ occurrences, on next message:
// getActiveAntiPatterns() returns:
// [{
//   tool_name: 'search',
//   subtype: 'wrong_tool_for_entity_query',
//   occurrences: 5,
//   correction: 'Use entity tool with type=event for calendar queries'
// }]

// 4. Injected into system prompt:
// "AVOID: When using 'search', do not wrong_tool_for_entity_query.
//  This error has occurred 5 times.
//  Instead: Use entity tool with type=event for calendar queries."

// 5. LLM reads correction → uses correct tool → error stops recurring
// 6. After 7 days without occurrence → pattern expires from prompt
```

## Related Patterns

- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
