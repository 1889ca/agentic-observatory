# Multi-Model Deliberation

> Combining multiple AI models for higher-confidence decisions through structured debate.

## Problem

Single-model responses have blind spots. A model may be confidently wrong, biased toward its training distribution, or miss perspectives that another architecture would catch. For high-stakes decisions — architecture choices, debugging complex issues, evaluating competing approaches — you want multiple opinions, not just one confident answer.

## Context

- An orchestrator that can dispatch to multiple AI model APIs (Claude, Gemini, DeepSeek, etc.)
- Decisions where confidence matters more than speed
- Topics where different models have different strengths (reasoning, code, research, creativity)
- Need for structured output (verdict, confidence, key findings) rather than raw chat

## Solution

### Deliberation Modes

The system supports multiple deliberation strategies, each suited to different question types:

**Research Mode** (default): All models independently research the topic, then a synthesis step combines findings into a structured summary.

```javascript
// Output format for research mode
{
  summary: {
    verdict: "Use WebSockets for real-time, SSE for unidirectional",
    confidence: 0.85,
    keyFindings: ["WebSocket has lower latency...", "SSE simpler to deploy..."],
    openQuestions: ["What about HTTP/3 streams?"]
  }
}
```

**Round-Robin**: Models take turns responding, each seeing previous responses. Builds iteratively toward consensus — each model can challenge or build on what came before.

**Moderator**: One model (typically the strongest reasoner) acts as moderator, directing questions to specialist models and synthesizing a final answer.

**Fibonacci (Reverse Engineering)**: Given a claim, models work backward to find supporting/refuting evidence. Named for its iterative deepening approach — each round digs deeper into the claim's foundation.

**Team**: Models assigned roles (devil's advocate, domain expert, pragmatist) and debate from those perspectives.

### Execution Model

- **Mutual exclusion:** Only one deliberation runs at a time (simple `running` flag)
- **Async dispatch:** Returns immediately with a deliberation ID; results fed back through the orchestrator's queue
- **Duration tracking:** Each deliberation logs how long it took for cost/latency monitoring

```javascript
async function deliberate(topic, mode, context) {
  if (running) throw new Error('Deliberation already in progress');
  running = true;

  const id = `hivemind-${Date.now()}`;
  // Fire and forget — results come back through the queue
  runDeliberation(topic, mode, context)
    .then(result => {
      enqueue({
        type: 'hivemind-result',
        id,
        result: formatResult(result, mode)
      });
    })
    .finally(() => { running = false; });

  return id;
}
```

### Integration with Orchestrator

The orchestrator exposes deliberation as an API endpoint, making it accessible to:
- Human users via chat interface
- Satellite agents that encounter decisions beyond their confidence threshold
- Scheduled tasks that need periodic re-evaluation of architectural choices

Results are auto-enqueued to the orchestrator's processing queue, where they're treated like any other input — the orchestrator can act on findings, store them, or relay them to the user.

## Implications

- Multiple API calls per deliberation = higher cost and latency (trade-off is intentional)
- Mutual exclusion means deliberations queue up — no parallel debates
- Model availability varies — a model API being down degrades the deliberation quality
- Structured output formats (verdict, confidence) depend on models following instructions consistently
- No persistent deliberation history — results exist only in the orchestrator's queue and memory
- Round-robin and moderator modes have O(n*rounds) API calls — can get expensive

## Code Example

```javascript
// Triggering deliberation from a satellite or API
const response = await fetch('http://localhost:3847/api/hivemind', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    topic: "Should we migrate from SQLite to PostgreSQL for the orchestrator?",
    mode: "research",
    context: "Current DB: SQLite with WAL mode. ~500 writes/day. Single machine."
  })
});

// Result arrives asynchronously in orchestrator's queue:
// {
//   type: 'hivemind-result',
//   result: {
//     verdict: "Stay with SQLite — your write volume is well within its capacity",
//     confidence: 0.92,
//     keyFindings: [...],
//     openQuestions: [...]
//   }
// }
```

## Related Patterns

- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
