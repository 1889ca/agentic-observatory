# Inner Monologue and Reflection

> A private reflection cycle where an agent thinks without broadcasting, deciding what to surface and what to resolve internally.

## Problem

Most AI agent architectures make all reasoning visible — every thought becomes a response. But effective agents need private processing: mulling over ambiguous signals, resolving internal conflicts, updating self-models, and deciding what deserves human attention versus what should stay internal. Without a private channel, agents either over-communicate (noise) or suppress reasoning entirely (missed insights).

## Context

- An agent that receives many signals (activity logs, system events, user messages) and needs to triage them
- Situations where the agent should exercise judgment about what deserves human attention
- Systems that benefit from the agent maintaining and evolving a self-model over time
- Agents that need to distinguish between "I should tell someone about this" and "I can handle this myself"
- Reflection is triggered by scheduled events (e.g., an evening summary cron) or activity thresholds (e.g., N events accumulated since last reflection)

## Solution

### Sandboxed Reflection Dispatch

The key architectural decision: reflection uses a separate AI dispatch with **no tool access**. This is pure thinking — no file writes, no API calls, no side effects. Giving the reflection step access to tools would create action loops where the agent acts on half-formed thoughts.

```javascript
async function reflect(triggerSource, activityContext) {
  if (reflectionMutex) return null;  // Prevent concurrent reflections
  reflectionMutex = true;

  const response = await dispatch({
    model: 'fast-model',
    systemPrompt: REFLECTION_PROMPT,
    allowedTools: [],       // No tools — pure thinking
    prompt: activityContext
  });

  reflectionMutex = false;
  return parseDecision(response);
}
```

The mutex is critical: concurrent reflections could produce contradictory outputs or race on shared state like the self-model.

### Surface vs. Resolve Decisions

The reflection prompt instructs the agent to produce structured output indicating whether its conclusion should be communicated to the user or handled internally:

- **Surface:** "This is worth telling the human." The surfaced text is extracted, injected into the conversation channel, and optionally triggers a push notification.
- **Resolve:** "I have handled this internally." Logged to the journal for audit purposes but not broadcast.

The agent's response is parsed for these structured indicators:

```javascript
function parseDecision(reflectionText) {
  const shouldSurface = detectSurfaceIntent(reflectionText);
  const surfacedContent = shouldSurface
    ? extractSurfacedContent(reflectionText)
    : null;

  return {
    decision: shouldSurface ? 'surface' : 'resolve',
    content: surfacedContent,
    fullText: reflectionText  // Always preserved for audit
  };
}
```

The default is to resolve internally — the agent must actively decide something is worth surfacing. This biases toward quiet competence rather than noise.

### Session Continuity

Reflections can resume the same underlying AI session, giving the agent a continuous inner thread that accumulates context across multiple reflection cycles. This means the agent's second reflection of the day "remembers" the first without re-injecting prior reflection text.

### Self-Model Evolution

As an optional enhancement, the agent can maintain a persistent self-description (a short text, roughly 400 characters) that evolves during reflection. Before each reflection, the current self-model is injected into context. If the reflection produces an updated self-description, it is persisted:

```javascript
const currentSelfModel = state.get('self_model');
// Inject into reflection context: "Your current self-description: ..."

// After reflection, check for evolution
if (newSelfModel && newSelfModel !== currentSelfModel) {
  state.set('self_model', newSelfModel);
  log('self_model_update', newSelfModel);
}
```

This creates a form of slow self-modification — the agent's identity drifts based on experience, but the short length cap and persistent logging provide safety rails.

### Journal Persistence

Every reflection — surfaced or resolved — is recorded in a journal with trigger source, decision type, timestamp, and full text. This creates an audit trail of the agent's inner reasoning that can be reviewed by humans or queried by the agent itself in future reflections.

## Implications

- Private reflection adds latency and token cost — should be triggered judiciously (scheduled intervals or activity thresholds), not on every event
- The no-tools constraint is the most important architectural decision: reflection that can take actions creates feedback loops and unintended side effects
- Self-model evolution is self-modifying behavior — the short length cap and human-visible journal provide safety rails, but drift is inherent
- Session continuity means the inner monologue accumulates context over time, which can drift or grow stale if not periodically reset
- The surface/resolve model gives the agent genuine editorial judgment about what humans see, which is powerful but requires trust in the agent's calibration
- A reflection mutex prevents concurrent reflections from producing contradictory conclusions

## Code Example

```javascript
// Triggered by an evening summary schedule
const result = await reflect('evening-summary', `
  Today's activity: 3 deploys, 1 failed flow recovery, user asked about billing.
  Pending: reconciliation found 2 orphaned tasks.
`);

if (result.decision === 'surface') {
  // Agent decided this is worth telling the human:
  // "The billing PR has been open for 3 days with no review.
  //  Want me to ping the team?"
  await notifyUser(result.content);
} else {
  // Agent resolved internally:
  // "The orphaned tasks are from yesterday's interrupted flow.
  //  They'll be cleaned up by the reconciler's next pass."
  log('reflection-resolved', result.fullText);
}
```

## Related Patterns

- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
