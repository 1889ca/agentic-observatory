# Evolution and Self-Improvement

> Success-first learning cycle where successDetector and evolution.observe() lead the improvement loop, with corrections as a secondary signal, coactivation tracking, anti-pattern extraction, and preference synthesis.

## Problem

An AI orchestrator handles thousands of interactions, but the lessons from those interactions — which tools work well together, which approaches produce poor results, which user preferences repeat — are lost unless someone manually reviews logs and updates the system. The orchestrator can't improve itself without a structured feedback loop.

## Context

- Long-running orchestrator with rich execution history
- Tool calls, user corrections, and reflex hits/misses generate signal
- System prompt and capability configuration are editable at runtime
- Need to distinguish genuine improvements from noise
- Multiple learning subsystems that must coordinate without interfering

## Solution

### Success Detection (Primary Signal)

The primary learning path is success detection. `successDetector.analyzeMessage()` inspects each completed interaction for positive signals — task completions, user confirmations, and low-friction exchanges. `evolution.observe()` records the behavioral context so the system can reinforce what worked:

```javascript
// learning/learner.js — success detection runs first
async function learn() {
  // 1. Detect and record successes — what went right?
  await successDetector.scan();

  // 2. Feed observations into the evolution module
  const successes = await successDetector.getRecent();
  for (const success of successes) {
    await evolution.observe(success);
  }

  // 3. Process corrections (secondary signal — see below)
  await processCorrections();

  // 4. Run pattern detection — recurring behaviors
  await patternDetector.scan();

  // 5. Check for skill promotion candidates
  // NOTE: Designed but not yet operational — reflex promotion is not implemented in Riley
  await skillMatcher.evaluate();
}
```

`successDetector.analyzeMessage()` can also be called inline during message processing to capture signal while context is fresh:

```javascript
// During message processing (non-blocking)
successDetector.analyzeMessage(correlationId, { request, response, toolCalls })
  .then(result => result.isSuccess && evolution.observe(result))
  .catch(() => {});
```

### Corrections-Based Learning (Secondary Signal)

User corrections remain a high-fidelity signal when they occur — explicit corrections represent unambiguous intent. They are processed after success detection, applying patterns that cross a frequency threshold:

```javascript
// learning/learner.js
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

- Success detection is the primary learning path — `successDetector.analyzeMessage()` and `evolution.observe()` run before corrections processing, reinforcing what works rather than waiting for failures
- Corrections remain the highest-fidelity signal when they occur, but they are relatively rare; success signals are abundant in normal operation and provide continuous learning without user friction
- Coactivation tracking reveals missing abstractions organically — frequently paired tools suggest a skill that should exist
- Anti-pattern injection into the system prompt is self-limiting (max 5 patterns, 7-day window) to prevent prompt bloat
- Preference synthesis operates on aggregate behavior, not individual interactions — it needs volume to be reliable
- The learning loop runs on a schedule, not in real-time, to avoid interfering with message processing
- All improvements have an audit trail — if a learned behavior causes problems, you can trace it back to the originating observations

## Code Example

```javascript
// Complete learning cycle: observe → analyze → improve

// 1. During message processing, capture signal inline (non-blocking)
trackRequest(correlationId, toolCallsLog).catch(() => {});
successDetector.analyzeMessage(correlationId, { request, response, toolCalls })
  .then(result => result.isSuccess && evolution.observe(result))
  .catch(() => {});
// Corrections are recorded when users explicitly correct behavior:
corrections.record(userId, originalResponse, correctedResponse).catch(() => {});

// 2. Scheduled learning job runs periodically
async function scheduledLearningCycle() {
  // Lead with success detection — reinforce what works
  await successDetector.scan();
  const successes = await successDetector.getRecent();
  for (const s of successes) {
    await evolution.observe(s);
  }

  // Then process corrections as a secondary signal
  await learner.processCorrections();

  // Analyze coactivation → suggest new skills
  const candidates = await coactivation.analyzeCoactivation();
  for (const candidate of candidates) {
    if (candidate.frequency > SKILL_PROMOTION_THRESHOLD) {
      // Aspirational: skill promotion from coactivation is designed but not yet implemented
      await proposeSkill(candidate);
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
