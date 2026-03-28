# Evolution and Self-Improvement

> Four-stage pipeline (observe, analyze, propose, apply) that formalizes self-improvement through a bounded observation queue, pattern detection from tool executions and corrections, formal proposals with risk assessment, and safety-gated application with revert capability.

## Problem

An AI orchestrator handles thousands of interactions, but the lessons from those interactions -- which tools work well together, which approaches produce poor results, which user preferences repeat -- are lost unless someone manually reviews logs and updates the system. The orchestrator can't improve itself without a structured feedback loop that separates observation from action and gates changes behind safety checks.

## Context

- Long-running orchestrator with rich execution history
- Tool calls, user corrections, reflex hits/misses, and tool chains generate signal
- System prompt, reflex rules, and capability configuration are editable at runtime
- Need to distinguish genuine patterns from noise before acting on them
- Changes must be reversible: a bad evolution should be revertible

## Solution

### Pipeline Architecture

The evolution engine is a four-stage pipeline coordinated by `lib/evolution/index.js`. Each stage is a separate module with its own concerns:

```
OBSERVE → ANALYZE → PROPOSE → APPLY
  observer.js   analyzer/   proposer/   applicator/
```

The full cycle runs via `evolution.runCycle()`:

```javascript
// lib/evolution/index.js
async function runCycle({ dryRun = false } = {}) {
  const results = { analysis: null, proposals: null, applications: null, errors: [] };

  // Step 1: Analyze unanalyzed observations for patterns
  results.analysis = await analyzer.analyze({ dryRun });

  // Step 2: Create proposals from stable patterns
  results.proposals = await proposer.proposeFromPatterns({ dryRun });

  // Step 3: Auto-apply eligible proposals (high confidence, low risk)
  results.applications = await applicator.autoApply({ dryRun });

  // Step 4: Expire old proposals
  await proposer.expireOldProposals();

  return results;
}
```

### Stage 1: Observe

The observer (`lib/evolution/observer.js`) captures events through a bounded, non-blocking queue. `observe()` is designed to be fast and fire-and-forget so it can be called inline during message processing without adding latency:

```javascript
// lib/evolution/observer.js
const ObservationType = {
  TOOL_EXECUTION: 'tool_execution',
  REFLEX_HIT: 'reflex_hit',
  REFLEX_MISS: 'reflex_miss',
  USER_CORRECTION: 'user_correction',
  TOOL_CHAIN: 'tool_chain',
  REPEATED_RESPONSE: 'repeated_response',
  PARAM_PATTERN: 'param_pattern',
  SUCCESS_SIGNAL: 'success_signal',
};

function observe(type, data, context = {}) {
  stats.observed++;

  // Enforce queue size limit (default 1000)
  if (queue.length >= maxSize) {
    stats.dropped++;
    return { queued: false, reason: 'queue_full' };
  }

  queue.push({ type, data, context, timestamp: new Date().toISOString() });

  // Start async processing if not already running
  if (!processing) processQueue().catch(err => logger.error({ err }));

  return { queued: true };
}
```

Convenience methods capture specific event types with appropriate data shapes:

```javascript
// Record a tool execution with sanitized params
evolution.observeToolExecution({
  tool: 'search_emails',
  params: { query: 'invoice' },  // Sensitive keys redacted automatically
  success: true,
  durationMs: 340,
  requestId: 'req-123',
});

// Record a tool chain (sequence of tools in one request)
evolution.observeToolChain({
  tools: ['search_emails', 'save_note', 'set_reminder'],
  success: true,
  requestId: 'req-123',
  steps: [{ tool: 'search_emails', success: true, durationMs: 340 }, ...],
});

// Record a user correction
evolution.observeUserCorrection({
  originalResponse: 'Meeting is at 3pm',
  correction: 'Meeting is at 3pm EST, not PST',
});
```

### Stage 2: Analyze

The analyzer scans unanalyzed observations for patterns. It detects recurring tool chains, parameter patterns, repeated responses, and reflex candidates. The analysis runs periodically (scheduled job), not inline:

```javascript
// Run analysis on recent observations
const analysis = await evolution.analyze({ batchSize: 100 });

// Active mining: scan conversation history and promote high-confidence patterns
const results = await evolution.analyzeAndPromote({
  days: 30,
  dryRun: false,
});
// Patterns above 0.9 confidence → auto-promoted to reflexes/skills
// Patterns 0.7-0.9 → queued for user approval
```

### Stage 3: Propose

Stable patterns are converted into formal proposals. Each proposal has a type, confidence score, risk level, and the data needed to apply it:

```javascript
// Create a proposal from a detected pattern
await evolution.propose({
  type: 'new_reflex',          // ProposalType
  data: {
    trigger: 'search_emails followed by save_note',
    suggestedReflex: { pattern: /search.*then save/i, response: '...' },
    evidenceCount: 47,
  },
  confidence: 0.87,
});

// Get pending proposals
const pending = await evolution.getProposals({ status: 'pending' });

// Manual approval/rejection
await evolution.approveProposal(proposalId, 'Looks correct');
await evolution.rejectProposal(proposalId, 'Too aggressive');
```

### Stage 4: Apply

The applicator implements approved proposals with safety checks. High-confidence, low-risk proposals can auto-apply; others wait for human approval:

```javascript
// Apply a specific approved proposal
const result = await evolution.apply(proposalId, {
  force: false,       // Skip safety checks (default false)
  appliedBy: 'auto',  // Who's applying: 'auto' or 'user'
});

// Revert a previously applied proposal
await evolution.revert(proposalId, 'Caused false positives in email triage');
```

### Coactivation Tracking

Tool coactivation is tracked separately in `lib/evolution/coactivation.js`. It records which tools are used in sequence, with success rates and timing, building a "synaptic" connection map:

```javascript
// lib/evolution/coactivation.js
async function trackRequest(requestId, toolCalls) {
  if (!toolCalls || toolCalls.length < 2) return;

  for (let i = 0; i < toolCalls.length - 1; i++) {
    const toolA = toolCalls[i];
    const toolB = toolCalls[i + 1];

    await upsertCoactivation({
      toolA: toolA.name,
      toolB: toolB.name,
      success: toolA.success && toolB.success,
      gapMs: toolB.timestamp - toolA.timestamp,
      context: { timestamp: new Date().toISOString(), aSuccess: toolA.success, bSuccess: toolB.success },
    });
  }
}

// Synapse strength combines frequency (log scale), success rate, and recency (14-day half-life)
function calculateSynapseStrength(coactivation) {
  const successRate = success_count / (success_count + failure_count);
  const frequency = Math.min(1, Math.log10(sequence_count + 1) / 2);
  const recency = Math.exp(-daysSince / 14);

  return successRate * 0.5 + frequency * 0.3 + recency * 0.2;
}
```

The evolution index exposes coactivation tracking as a convenience method:

```javascript
// Called after each request completes
evolution.trackCoactivations(requestId, toolCalls);
```

### Auto-Learn Integration

The evolution module also coordinates auto-learn extraction, which mines conversation turns for learnable patterns:

```javascript
// Queue a conversation turn for auto-learn extraction
evolution.queueAutoLearnExtraction(turn);
```

This is exposed as a convenience method so callers can depend on a single "learning boundary" (the evolution module) instead of importing multiple learning submodules.

## Implications

- The bounded queue (default 1000 items) prevents memory issues during high-traffic periods: observations are dropped rather than causing backpressure. Drop rate is tracked in `stats.dropped`
- Observation persistence uses a 50ms delay between DB writes to avoid hammering the database during queue drains
- The four-stage pipeline creates a natural audit trail: every improvement can be traced from applied change back through proposal, pattern, and originating observations
- Auto-apply is gated by both confidence threshold and risk level: high-confidence + high-risk still requires human approval
- Revert capability means evolution is not a one-way ratchet: bad changes can be undone, and the revert is itself logged
- Coactivation strength decays with a 14-day half-life, so stale patterns fade naturally without manual cleanup
- The `runCycle()` function catches errors per-phase: a failing analyzer does not prevent the applicator from processing already-approved proposals
- Observation cleanup deletes analyzed observations after 30 days and deprecated patterns after 90 days to prevent unbounded table growth

## Code Example

```javascript
// Complete evolution lifecycle

// 1. During message processing (non-blocking, inline)
evolution.observeToolExecution({
  tool: 'search_emails', success: true, durationMs: 250, requestId: 'req-1'
});
evolution.observeToolExecution({
  tool: 'save_note', success: true, durationMs: 80, requestId: 'req-1'
});
evolution.observeToolChain({
  tools: ['search_emails', 'save_note'], success: true, requestId: 'req-1'
});
evolution.trackCoactivations('req-1', [
  { name: 'search_emails', success: true, durationMs: 250, timestamp: 1000 },
  { name: 'save_note', success: true, durationMs: 80, timestamp: 1330 },
]);

// 2. Scheduled evolution cycle (runs periodically)
const cycle = await evolution.runCycle();
// cycle.analysis: { patternsFound: 3, newObservationsProcessed: 47 }
// cycle.proposals: { created: 1, type: 'new_reflex' }
// cycle.applications: { applied: 0, pending: 1 }

// 3. User reviews pending proposals
const proposals = await evolution.getProposals({ status: 'pending' });
// [{ id: 'prop-1', type: 'new_reflex', confidence: 0.87, data: { ... } }]

await evolution.approveProposal('prop-1', 'Good pattern');

// 4. Next cycle auto-applies the approved proposal
const nextCycle = await evolution.runCycle();
// nextCycle.applications: { applied: 1 }

// 5. If the reflex causes problems, revert it
await evolution.revert('prop-1', 'False positives on newsletter emails');
```

## Related Patterns

- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
- [Declarative Capability System](./declarative-capability-system.md)
