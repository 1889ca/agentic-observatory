# Dynamic System Prompt Composition

> System prompt assembled from hardcoded persona and behaviors, with capability manifest and anti-patterns appended at dispatch time.

## Problem

A static system prompt becomes stale as the orchestrator evolves. New capabilities and learned anti-patterns need to influence how the LLM behaves — but a monolithic prompt file can't adapt at runtime. Manually updating it for every new tool or behavioral correction doesn't scale and introduces drift between what the prompt says and what the system actually does.

## Context

- An orchestrator with a growing set of capabilities and integrations
- Persona and behavioral guidelines that are stable and hardcoded
- Anti-patterns learned from operational mistakes that should prevent recurrence
- A capability manifest that grows as tools are added

## Solution

### Prompt Structure

The system prompt is assembled from a small number of fixed sections, not a dynamic multi-layer pipeline:

```
Hardcoded Persona + Behaviors → Capability Manifest → Anti-Patterns → Final Prompt
```

### Persona and Behavioral Rules (Hardcoded)

The base personality, role definition, and behavioral rules are hardcoded strings — not fetched from a database or dynamically composed:

```javascript
const PERSONA = `# Identity
Riley — orchestrator and project manager

# Core Behaviors
- Be concise and action-oriented
- Always confirm before destructive operations
- Log decisions for auditability
- When unsure, ask rather than guess`;
```

These change only when the code changes. There is no dynamic skill injection or vibe detection layer — the persona is stable.

### Capability Manifest (Appended)

A summary of available capability categories is appended so the LLM knows what tools exist:

```javascript
function buildCapabilitySummary() {
  const categories = toolRegistry.getCategories();

  return `# Available Capabilities
${categories.map(c =>
  `## ${c.name} (${c.tools.length} tools)\n${c.description}`
).join('\n\n')}

Individual tool schemas are provided separately via function declarations.`;
}
```

### Anti-Patterns (Appended)

Learned mistakes are appended to prevent recurrence:

```javascript
async function buildAntiPatterns() {
  const patterns = await antiPatterns.getActive();
  if (patterns.length === 0) return '';

  return `# Anti-Patterns (DO NOT)
${patterns.map(p => `- ${p.description} → Instead: ${p.correction}`).join('\n')}`;
}
```

### Final Assembly

```javascript
async function composeSystemPrompt() {
  const capabilities = buildCapabilitySummary();
  const antiPatternSection = await buildAntiPatterns();

  const sections = [PERSONA, capabilities, antiPatternSection];

  return sections.filter(Boolean).join('\n\n---\n\n');
}
```

## Implications

- The prompt is simpler and more predictable than a multi-layer dynamic composition — fewer moving parts means fewer surprises
- Anti-patterns still grow over time and need periodic pruning to stay within token budgets
- No per-user customization or vibe detection — the same prompt serves all contexts
- Capability manifest is the only truly dynamic section; persona and behaviors are stable
- Changes to persona or behavioral rules require a code change, not a database update
- The prompt is rebuilt on every dispatch — but only the anti-patterns section requires an async fetch

## Code Example

```javascript
// Dispatch with prompt composition
async function dispatch(message, conversation) {
  const systemPrompt = await composeSystemPrompt();

  const response = await model.generate({
    systemInstruction: systemPrompt,
    contents: conversation.messages,
    tools: capabilities.getDeclarations()
  });

  return response;
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Message Processing Pipeline](./message-processing-pipeline.md)
