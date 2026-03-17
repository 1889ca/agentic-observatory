# Evolution and Self-Improvement

> Corrections-driven learning cycle with coactivation tracking, anti-pattern extraction, and preference synthesis from operational data.

## Problem

An AI orchestrator handles thousands of interactions, but the lessons from those interactions — which tools work well together, which approaches produce poor results, which user preferences repeat — are lost unless someone manually reviews logs and updates the system. The orchestrator can't improve itself without a structured feedback loop.

## Context

- Long-running orchestrator with rich execution history
- Tool calls, user corrections, and reflex hits/misses generate signal
- System prompt and capability configuration are editable at runtime
- Need to distinguish genuine improvements from noise
- Multiple learning subsystems that must coordinate without interfering

## Solution

### Corrections-Based Learning

The primary learning signal comes from user corrections — moments where the user explicitly corrects the agent's behavior. A dedicated corrections system tracks these and applies them through a correction applicator:

```javascript
// learning/learner.js — orchestrates all learning subsystems
async function processCorrections({ dryRun = false } = {}) {
  const stats = await corrections.getStats(30); // Last 30 days

  for (const correction of stats.patterns) {
    if (correction.frequency >= CORRECTION_THRESHOLD) {
      const improvement = await correctionApplicator.apply(correction, { dryRun });
      if (improvement && !dryRun) {
        await recordImprovement(improvement);
      }
    }
  }
}
```

### Coactivation Tracking

Tools that are consistently called together in the same request signal a missing higher-level abstraction:

```javascript
// evolution/coactivation.js
async function trackRequest(requestId, toolCalls) {
  if (!toolCalls || toolCalls.length < 2) return;

  for (let i = 0; i < toolCalls.length - 1; i++) {
    const toolA = toolCalls[i];
    const toolB = toolCalls[i + 1];

    await db.query(`
      INSERT INTO coactivation_pairs (tool_a, tool_b, count)
      VALUES ($1, $2, 1)
      ON CONFLICT (tool_a, tool_b)
      DO UPDATE SET count = coactivation_pairs.count + 1
    `, [toolA.name, toolB.name]);
  }
}

// Periodic analysis: high-frequency pairs → candidate skills
async function analyzeCoactivation() {
  const pairs = await db.query(`
    SELECT tool_a, tool_b, count FROM coactivation_pairs
    WHERE count > $1
    ORDER BY count DESC
  `, [COACTIVATION_THRESHOLD]);

  return pairs.map(p => ({
    tools: [p.tool_a, p.tool_b],
    frequency: p.count,
    candidateSkill: `${p.tool_a}-then-${p.tool_b}`,
  }));
}
```

### Anti-Pattern Extraction

When protocol errors (LLM misusing a tool) recur, they're extracted as anti-patterns and injected into the system prompt. This is handled by the anti-pattern learning loop (see [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)):

```javascript
// After ANTI_PATTERN_THRESHOLD occurrences, the error pattern
// gets formatted as a correction and added to context assembly:
// "When searching for calendar events, use entity tool with
//  type=event, not the search tool"
```

### Preference Synthesis

The vibe subsystem mines behavioral patterns to infer user preferences without explicit feedback:

```javascript
// Correction mining:
// "user corrected date format 4 times → learn ISO format preference"

// Tool parameter analysis:
// "user always passes format='iso' → default to ISO in future"

// Response pattern mining:
// "user prefers bullet points over prose → adjust response style"
```

### Learning Orchestration

The learner module coordinates all learning subsystems, running as a scheduled job:

```javascript
// learning/learner.js — main orchestrator
async function learn() {
  // 1. Process accumulated corrections
  await processCorrections();

  // 2. Run success detection — what went right?
  await successDetector.scan();

  // 3. Run pattern detection — recurring behaviors
  await patternDetector.scan();

  // 4. Check for skill promotion candidates
  // NOTE: Designed but not yet operational — reflex promotion is not implemented in Riley
  await skillMatcher.evaluate();
}
```

### Improvement Recording

All improvements are logged with the observations that motivated them, creating an audit trail:

```javascript
// improvements.js
async function recordImprovement(improvement) {
  await db.query(`
    INSERT INTO self_improvements
    (type, description, source, confidence, applied_at)
    VALUES ($1, $2, $3, $4, NOW())
  `, [improvement.type, improvement.description, improvement.source, improvement.confidence]);
}
```

## Implications

- Corrections are the highest-fidelity learning signal — they represent explicit user intent, not inferred patterns
- Coactivation tracking reveals missing abstractions organically — frequently paired tools suggest a skill that should exist
- Anti-pattern injection into the system prompt is self-limiting (max 5 patterns, 7-day window) to prevent prompt bloat
- Preference synthesis operates on aggregate behavior, not individual interactions — it needs volume to be reliable
- The learning loop runs on a schedule, not in real-time, to avoid interfering with message processing
- All improvements have an audit trail — if a learned behavior causes problems, you can trace it back to the originating observations

## Code Example

```javascript
// Complete learning cycle: observe → analyze → improve
// 1. During message processing, observations are recorded (non-blocking)
trackRequest(correlationId, toolCallsLog).catch(() => {});
corrections.record(userId, originalResponse, correctedResponse).catch(() => {});

// 2. Scheduled learning job runs periodically
async function scheduledLearningCycle() {
  // Process corrections → generate improvements
  await learner.processCorrections();

  // Analyze coactivation → suggest new skills
  const candidates = await coactivation.analyzeCoactivation();
  for (const candidate of candidates) {
    if (candidate.frequency > SKILL_PROMOTION_THRESHOLD) {
      // Aspirational: skill promotion from coactivation is designed but not yet implemented
      await proposeSKill(candidate);
    }
  }

  // Anti-patterns are handled separately via error triage
  // (see anti-pattern-learning-loop pattern)
}
```

## Related Patterns

- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
