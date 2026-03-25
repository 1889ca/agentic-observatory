# Dynamic System Prompt Composition

> Multi-layer system prompt assembled from hardcoded persona, dynamic vibe context with preference synthesis, skill injection based on message content, capability manifest, and anti-patterns — all composed at dispatch time.

## Problem

A static system prompt becomes stale as the orchestrator evolves. New capabilities and learned anti-patterns need to influence how the LLM behaves — but a monolithic prompt file can't adapt at runtime. Beyond tools, the agent's conversational style should adapt to the user's preferences and communication patterns, and relevant skills should be surfaced based on what the user is asking about.

## Context

- An orchestrator with a growing set of capabilities and integrations
- Persona and behavioral guidelines that form a stable base
- A vibe detection layer that synthesizes user preferences, domain confidence levels, and knowledge gaps
- Dynamic skill injection that surfaces relevant skills based on message content
- Anti-patterns learned from operational mistakes that should prevent recurrence
- A capability manifest that grows as tools are added

## Solution

### Prompt Structure

The system prompt is assembled from multiple layers, some static and some dynamically composed per-message:

```
Hardcoded Persona → Vibe Context (dynamic) → Skill Injection (dynamic) → Capability Manifest → Anti-Patterns → Final Prompt
```

### Persona and Behavioral Rules (Base Layer)

The base personality and role definition are hardcoded strings that form the stable foundation:

```javascript
const PERSONA = `# Identity
Riley — orchestrator and project manager

# Core Behaviors
- Be concise and action-oriented
- Always confirm before destructive operations
- Log decisions for auditability
- When unsure, ask rather than guess`;
```

### Vibe Context (Dynamic Layer)

`getVibeContext()` synthesizes a preference profile from the user's communication patterns, builds domain confidence levels from operational history, and generates knowledge gap questions for areas where confidence is low:

```javascript
function getVibeContext(conversation) {
  const preferenceProfile = synthesizePreferences(conversation);
  const domainConfidence = getDomainConfidenceLevels();
  const knowledgeGaps = identifyKnowledgeGaps(domainConfidence);

  return `# Communication Style
${preferenceProfile.summary}

# Domain Confidence
${Object.entries(domainConfidence)
  .map(([domain, level]) => `- ${domain}: ${level.toFixed(2)}`)
  .join('\n')}

# Knowledge Gaps — Ask About
${knowledgeGaps.map(g => `- ${g.question} (domain: ${g.domain})`).join('\n')}`;
}
```

This layer adapts the agent's tone, detail level, and proactive behavior based on who it's talking to and what it knows well.

### Skill Injection (Dynamic Layer)

Before composing the final prompt, the system searches for skills relevant to the current user message and injects their descriptions so the LLM knows they're available:

```javascript
async function getSkillContext(userMessage) {
  const relevant = await skills.findRelevantSkills(userMessage);
  if (relevant.length === 0) return '';

  return `# Relevant Skills
${relevant.map(s => `## ${s.name}\n${s.description}\nTrigger: ${s.trigger}`).join('\n\n')}`;
}
```

This means the prompt is not the same for every message — different user queries surface different skill sets.

### Capability Manifest and Anti-Patterns (Appended)

These work the same as the base layers — capability categories summarize available tools, and learned anti-patterns are appended to prevent recurrence:

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
async function composeSystemPrompt(userMessage, conversation) {
  const vibeContext = getVibeContext(conversation);
  const skillContext = await getSkillContext(userMessage);
  const capabilities = buildCapabilitySummary();
  const antiPatternSection = await buildAntiPatterns();

  const sections = [PERSONA, vibeContext, skillContext, capabilities, antiPatternSection];

  return sections.filter(Boolean).join('\n\n---\n\n');
}
```

## Implications

- The prompt varies per message — vibe context adapts to conversation history, skill injection adapts to message content
- Preference synthesis means the agent's communication style drifts over time as it observes user patterns
- Domain confidence levels create a feedback loop: the agent is more autonomous in high-confidence areas and more cautious (asking questions) in low-confidence ones
- Skill injection adds relevant context but increases token usage — the skill search must be fast and selective
- Anti-patterns still grow over time and need periodic pruning to stay within token budgets
- The prompt is rebuilt on every dispatch with multiple async fetches (skills, anti-patterns)
- More dynamic layers means more potential for unexpected interactions between sections

## Code Example

```javascript
// Dispatch with full dynamic composition
async function dispatch(message, conversation) {
  const systemPrompt = await composeSystemPrompt(message, conversation);

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
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
