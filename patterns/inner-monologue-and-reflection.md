# Inner Monologue and Reflection

> A private reflection cycle where an agent thinks without broadcasting, deciding what to surface and what to resolve internally.

## Problem

Most AI agent architectures make all reasoning visible — every thought becomes a response. But effective agents need private processing: mulling over ambiguous signals, resolving internal conflicts, updating self-models, and deciding what's worth communicating versus what should stay internal. Without a private channel, agents either over-communicate (noise) or suppress reasoning entirely (missed insights).

## Context

- An agent that receives many signals (activity logs, system events, user messages) and needs to triage them
- Situations where the agent should exercise judgment about what deserves human attention
- Systems that benefit from the agent maintaining and evolving a self-model
- Agents that need to distinguish between "I should tell someone about this" and "I can handle this myself"

## Solution

### Sandboxed Inner Prompt

Reflection uses a separate AI dispatch with no tools — pure thinking, no actions:

```javascript
async function reflect(triggerSource, context) {
  if (reflecting) return { decision: 'resolve', surfaced: null };
  reflecting = true;

  const options = {
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: { text: INNER_PROMPT },
    allowedTools: [],        // No tools — pure thinking
    disallowedTools: ['*'],  // Explicit deny-all
  };

  // Session continuity: resume previous reflection chain
  if (sessionId) options.resume = sessionId;

  for await (const message of query({ prompt: context, options })) {
    // Collect the full reflection text
  }
}
```

### Three-Directive Decision Model

The inner prompt instructs the agent to conclude each reflection with one of three directives:

- **`SURFACE: <text>`** — "This is worth telling the human." The surfaced text gets injected into the conversation and triggers a push notification.
- **`RESOLVE: <text>`** — "I've handled this internally." Logged to the journal but not broadcast.
- **`MANTRA: <text>`** — "My self-description has evolved." Updates the agent's persistent self-model.

```javascript
function parseDecision(text) {
  const mantraMatch = text.match(/MANTRA:\s*(.+?)(?:\n|$)/s);
  const surfaceMatch = text.match(/SURFACE:\s*(.+)/s);
  const resolveMatch = text.match(/RESOLVE:\s*(.+)/s);

  // Default to resolve (internal handling) if no explicit directive
  return {
    decision: surfaceMatch ? 'surface' : 'resolve',
    surfaced: surfaceMatch?.[1]?.trim() ?? null,
    mantra: mantraMatch?.[1]?.trim() ?? null,
  };
}
```

### Mantra Evolution

The agent maintains a persistent self-description (~400 chars) that can evolve during reflection. Before each reflection, the current mantra is injected into context:

```javascript
const currentMantra = state.get('mantra');
const mantraCtx = currentMantra
  ? `Your current mantra: "${currentMantra}"`
  : 'You don\'t have a mantra yet. Write one — a short self-description that captures who you are.';

// After reflection, persist if changed
if (mantra && mantra !== previous) {
  state.set('mantra', mantra);
  logActivity('mantra_update', null, `Mantra evolved: ${mantra.slice(0, 100)}`);
}
```

### Session Continuity

Reflections resume the same underlying AI session, giving the agent a continuous inner thread that accumulates context across multiple reflection cycles.

### Journal Persistence

Every reflection — surfaced or resolved — is recorded in a journal table with trigger source, decision type, and full text. This creates an audit trail of the agent's inner reasoning.

## Implications

- Private reflection adds latency and token cost — should be triggered judiciously, not on every event
- The no-tools constraint is critical: reflection that can take actions creates feedback loops
- Mantra evolution is self-modifying behavior — the 400-char cap and human-visible logging provide safety rails
- Session continuity means the inner monologue accumulates context over time, which could drift
- The SURFACE/RESOLVE model gives the agent genuine editorial judgment about what humans see
- A `reflecting` mutex prevents concurrent reflections, which could produce contradictory outputs

## Code Example

```javascript
// Triggered by evening intention
const result = await reflect('evening-summary', `
  Today's activity: 3 deploys, 1 failed flow recovery, user asked about billing.
  Pending: kanban reconciliation found 2 orphaned tasks.
`);

// Agent might resolve internally:
// RESOLVE: The orphaned tasks are from yesterday's interrupted flow.
//          They'll be cleaned up by the reconciler's next pass.
// MANTRA: I help my human by handling operational noise silently
//         and only surfacing what changes their priorities.

// Or surface something important:
// SURFACE: The billing PR has been open for 3 days with no review.
//          Want me to ping the team?
```

## Related Patterns

- [Intent-Driven Self-Scheduling](./intent-driven-self-scheduling.md)
- [Session Consolidation and Memory](./session-consolidation-and-memory.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
