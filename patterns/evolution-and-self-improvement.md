# Evolution and Self-Improvement

> Observe-analyze-propose-apply cycle for autonomous system improvement from operational data.

## Problem

An AI orchestrator handles thousands of interactions, but the lessons from those interactions — which tools work well together, which prompts produce poor results, which patterns repeat — are lost unless someone manually reviews logs and updates the system. The orchestrator can't improve itself without a structured feedback loop.

## Context

- Long-running orchestrator with rich execution history
- Tool calls, user corrections, reflex hits/misses generate signal
- System prompt and capability configuration are editable at runtime
- Need to distinguish genuine improvements from noise
- Human oversight required for non-trivial changes

## Solution

### Four-Phase Cycle

The evolution engine operates as a continuous loop:

**OBSERVE** — Record structured events from normal operation:
- Tool executions (what was called, with what params, success/failure)
- User corrections (what the LLM said vs. what the user wanted)
- Reflex accuracy (did the automation do the right thing?)
- Coactivation patterns (which tools are called together frequently?)

```javascript
// Every tool execution generates an observation
function recordObservation(event) {
  observations.push({
    type: event.type,        // 'tool_exec' | 'correction' | 'reflex_hit'
    tool: event.tool,
    params: event.params,
    outcome: event.outcome,  // 'success' | 'failure' | 'corrected'
    timestamp: Date.now()
  });
}
```

**ANALYZE** — Periodically scan observations for stable patterns:
- Tool pairs that always co-occur → candidate for a new skill
- Repeated corrections on the same topic → anti-pattern to learn
- Reflex misfire clusters → condition needs tightening
- Performance regressions → identify root cause

**PROPOSE** — Generate formal proposals for system changes:
- New skills from coactivation clusters
- Anti-pattern rules for the system prompt
- Reflex condition adjustments
- Proposals require a confidence threshold before surfacing

**APPLY** — Implement approved changes:
- Low-risk proposals (anti-pattern additions) can self-apply
- Structural changes (new skills, reflex modifications) require human approval
- All changes are logged with the observations that motivated them

### Anti-Pattern Learning

When users correct the orchestrator, the correction is analyzed and distilled into a rule:

```javascript
// Extracted from correction patterns
const antiPattern = {
  trigger: 'When user asks about calendar events',
  wrong: 'Searching notes instead of calendar entities',
  right: 'Use entity tool with type=event, not search tool',
  confidence: 0.87,
  observationCount: 12
};
// Injected into system prompt on next dispatch
```

### Coactivation Tracking

Tools that are consistently called together signal a missing higher-level abstraction:

```javascript
// If entity.create('task') + entity.update('project') co-occur >80% of the time,
// propose a skill that combines them: "add-task-to-project"
const coactivations = analyzeCoactivation(recentObservations);
for (const [pair, frequency] of coactivations) {
  if (frequency > 0.8) {
    proposeSkill(pair);
  }
}
```

## Implications

- The system accumulates learned behaviors that aren't visible in the source code
- Anti-patterns in the system prompt grow over time — needs periodic pruning
- False positives in pattern detection can degrade performance if auto-applied
- The observation store grows unbounded — needs TTL or aggregation
- Self-improvement creates a feedback loop: bad improvements can compound
- Human oversight is the critical safety valve — especially for structural changes

## Code Example

```javascript
// Periodic evolution cycle (runs as scheduled job)
async function evolve() {
  const observations = await getRecentObservations({ hours: 24 });

  // Analyze for patterns
  const patterns = analyzePatterns(observations);
  const antiPatterns = extractAntiPatterns(observations);
  const coactivations = analyzeCoactivation(observations);

  // Generate proposals
  const proposals = [];
  for (const ap of antiPatterns) {
    if (ap.confidence > 0.85 && ap.observationCount > 10) {
      proposals.push({ type: 'anti-pattern', data: ap, autoApply: true });
    }
  }
  for (const skill of coactivations) {
    if (skill.frequency > 0.8) {
      proposals.push({ type: 'new-skill', data: skill, autoApply: false });
    }
  }

  // Apply or queue for approval
  for (const p of proposals) {
    if (p.autoApply) await apply(p);
    else await queueForApproval(p);
  }
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
