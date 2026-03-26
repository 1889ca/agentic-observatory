# Dynamic System Prompt Composition

> Multi-layer system prompt assembled from hardcoded persona, a vibe subsystem with preference synthesis and confidence tracking, skill injection based on message content, capability manifest, and anti-patterns — all composed at dispatch time.

## Problem

A static system prompt becomes stale as the orchestrator evolves. New capabilities and learned anti-patterns need to influence how the LLM behaves — but a monolithic prompt file can't adapt at runtime. Beyond tools, the agent's conversational style should adapt to the user's preferences and communication patterns, and relevant skills should be surfaced based on what the user is asking about.

## Context

- An orchestrator with a growing set of capabilities and integrations
- Persona and behavioral guidelines that form a stable base
- A vibe subsystem (`lib/vibe/`) with multiple specialized modules for preference synthesis, confidence tracking, knowledge-gap detection, and outcome reactions
- Dynamic skill injection that surfaces relevant skills based on message content
- Anti-patterns learned from operational mistakes that should prevent recurrence
- A capability manifest that grows as tools are added

## Solution

### Prompt Structure

The system prompt is assembled from multiple layers, some static and some dynamically composed per-message:

```
Hardcoded Persona → Vibe Context (dynamic subsystem) → Skill Injection (dynamic) → Capability Manifest → Anti-Patterns → Final Prompt
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

### Vibe Subsystem (Dynamic Layer)

The vibe layer is not a single function but a subsystem (`lib/vibe/`) composed of multiple specialized modules:

**Synthesizer** — aggregates user communication patterns into a preference profile:

```javascript
// lib/vibe/synthesizer.js
function synthesizePreferences(conversation) {
  const patterns = analyzePatterns(conversation);
  return {
    summary: buildStyleSummary(patterns),
    detailLevel: patterns.preferredDetailLevel,
    formality: patterns.formality,
    proactivity: patterns.proactivityPreference,
  };
}
```

**Confidence Tracker** — maintains domain-level confidence scores based on operational history. Higher confidence in a domain means more autonomous behavior; lower confidence triggers caution:

```javascript
// lib/vibe/confidence.js
function getDomainConfidenceLevels() {
  const domains = getAllTrackedDomains();
  return Object.fromEntries(
    domains.map(d => [d.name, d.confidenceScore])
  );
}
// Returns: { 'billing-api': 0.87, 'auth-service': 0.42, 'infra': 0.65 }
```

**Knowledge-Gap Detection** — identifies areas where confidence is low and generates questions the agent should ask to fill gaps:

```javascript
// lib/vibe/knowledge-gaps.js
function identifyKnowledgeGaps(domainConfidence) {
  return Object.entries(domainConfidence)
    .filter(([, score]) => score < CONFIDENCE_THRESHOLD)
    .map(([domain, score]) => ({
      domain,
      score,
      question: generateGapQuestion(domain),
    }));
}
```

**Outcome Reactor** — adjusts vibe state based on action outcomes. Successes reinforce confidence; failures trigger reassessment:

```javascript
// lib/vibe/outcome-reactor.js
function reactToOutcome(domain, outcome) {
  if (outcome.success) {
    incrementConfidence(domain, SMALL_INCREMENT);
  } else {
    decrementConfidence(domain, LARGE_DECREMENT); // asymmetric: failures hit harder
    recordKnowledgeGap(domain, outcome.context);
  }
}
```

**Combined Vibe Context** — the subsystem modules are composed into the prompt section:

```javascript
// lib/vibe/index.js
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

### Capability Manifest and Anti-Patterns (Appended)

Capability categories summarize available tools, and learned anti-patterns are appended to prevent recurrence:

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
- The vibe subsystem creates a feedback loop: operational outcomes adjust confidence, which adjusts the prompt, which adjusts agent behavior
- Domain confidence levels make the agent more autonomous in high-confidence areas and more cautious (asking questions) in low-confidence ones
- Asymmetric outcome reactions (failures hit harder) create a conservative drift — the agent becomes cautious faster than it becomes confident
- Preference synthesis means the agent's communication style drifts over time as it observes user patterns
- Skill injection adds relevant context but increases token usage — the skill search must be fast and selective
- Anti-patterns grow over time and need periodic pruning to stay within token budgets
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

  // After execution, feed outcome back into vibe subsystem
  const domain = detectDomain(message);
  reactToOutcome(domain, { success: response.success, context: message });

  return response;
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Message Processing Pipeline](./message-processing-pipeline.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
