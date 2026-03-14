# Narrative Memory Generation

> Convert structured operational data into story-form memories with semantic valence for richer retrieval and learning.

## Problem

Agents accumulate structured logs — flow completions, error reports, postmortems — but structured data is hard to reason about in future context windows. When an agent needs to recall "what happened last time we deployed the billing service," a JSON log entry is less useful than a narrative: "On March 5th, the billing deploy failed because the migration script timed out. We learned to run migrations separately before deploying." Without narrative form, agents lose the ability to learn from experience.

## Context

- An agent that generates postmortem reports, flow completion summaries, or structured event logs
- Semantic memory systems that use embedding-based retrieval (narratives embed better than structured data)
- Systems where understanding *why* something happened matters more than *what* happened
- Long-running agents that need to build institutional knowledge over time

## Solution

### Structured-to-Narrative Conversion

A narrative generator takes structured event data and produces story-form memories:

```javascript
function generateNarrative({ date, subject, events, outcome, valence, learning }) {
  const eventList = events.map((e, i) => `${i + 1}. ${e}`).join('\n');
  const content = [
    `On ${date}, regarding ${subject}:`,
    eventList,
    `Outcome (${valence}): ${outcome}`,
    `Learning: ${learning}`,
  ].join('\n');

  const confidence = valence === 'positive' ? 0.9
    : valence === 'negative' ? 0.85
    : 0.8;

  return store('narrative', subject, content, {
    confidence,
    source: 'narrative-generator',
  });
}
```

### Valence Detection

Each narrative carries a semantic valence — positive, negative, or neutral — determined by keyword analysis:

```javascript
function guessValence(text) {
  const negWords = ['fail', 'crash', 'error', 'slow', 'retry', 'missing', 'broke', 'stuck'];
  const posWords = ['success', 'improv', 'fast', 'clean', 'resolved', 'fixed', 'smooth'];

  const negScore = negWords.filter(w => lower.includes(w)).length;
  const posScore = posWords.filter(w => lower.includes(w)).length;

  if (negScore > posScore) return 'negative';
  if (posScore > negScore) return 'positive';
  return 'neutral';
}
```

Valence affects confidence scoring: positive outcomes are stored with higher confidence (0.9) because successes are more reliable references than failures (which may have been fixed since).

### Postmortem Extraction

Postmortem reports are parsed for numbered findings, and each finding becomes its own narrative memory:

```javascript
async function extractNarratives(reportText, date) {
  const findingPattern = /^\s*\d+\.\s+\*{0,2}(.+?)\*{0,2}\s*[:\u2014\u2013-]+\s*(.+)/gm;

  while ((match = findingPattern.exec(reportText)) !== null) {
    const subject = match[1].trim();
    const description = match[2].trim();
    await generateNarrative({
      date,
      subject: `postmortem: ${subject}`,
      events: [description],
      outcome: description,
      valence: guessValence(description),
      learning: description,
    });
  }
}
```

### Integration with Semantic Memory

Narratives are stored through the same `store()` function as all other memories, meaning they get embedded and become retrievable via semantic search. The story form means they embed well against natural-language queries like "what went wrong with deployments last week?"

## Implications

- Narrative form trades precision for retrievability — the story is easier to find but may lose structured detail
- Keyword-based valence detection is approximate; ambiguous text defaults to neutral
- Each postmortem finding becomes a separate memory, which could fragment a single incident across many entries
- Confidence scoring by valence is a heuristic — negative experiences may actually be more valuable to recall
- No deduplication: repeated similar events generate repeated narratives (useful for frequency detection, costly for storage)
- The learning field is critical — it's what makes narratives actionable rather than merely historical

## Code Example

```javascript
// After a flow completes, generate a narrative
await generateNarrative({
  date: '2025-03-10',
  subject: 'observatory maintain flow',
  events: [
    'Triggered scheduled maintenance for pattern library',
    'Compared 16 patterns against Riley codebase',
    'Found 3 new patterns to document',
    'Generated pattern files and updated registry',
  ],
  outcome: 'Pattern library updated from 16 to 19 patterns',
  valence: 'positive',
  learning: 'Regular maintenance catches new patterns within 1-2 weeks of implementation',
});
```

## Related Patterns

- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Domain-Aware Memory Scoring](./domain-aware-memory-scoring.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
