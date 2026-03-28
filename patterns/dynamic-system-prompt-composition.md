# Dynamic System Prompt Composition

> Multi-layer system prompt assembled via template string concatenation from hardcoded persona, user profile, behavioral rules, capability manifest, anti-patterns, triggered skills, and a vibe subsystem with preference synthesis and confidence tracking.

## Problem

A static system prompt becomes stale as the orchestrator evolves. New capabilities and learned anti-patterns need to influence how the LLM behaves — but a monolithic prompt file can't adapt at runtime. Beyond tools, the agent's conversational style should adapt to the user's preferences and communication patterns, and relevant skills should be surfaced based on what the user is asking about.

## Context

- An orchestrator with a growing set of capabilities and integrations
- Persona and behavioral guidelines that form a stable base
- A user profile layer (`lib/user-profile.js`) that enriches the prompt with identity facts, active projects, and preferences
- A vibe subsystem (`lib/vibe/`) with modules for preference synthesis, confidence tracking, and knowledge-gap detection
- Dynamic skill injection that surfaces relevant skills based on message content
- Anti-patterns learned from operational mistakes that should prevent recurrence
- A capability manifest that grows as tools are added

## Solution

### Prompt Structure

The system prompt is assembled using template string concatenation (not `---` separators) from multiple layers. Each section is a string that may be empty if its data source fails:

```
Persona + User Profile + Behaviors + Capability Manifest + Anti-Patterns + Skills + Vibe Context
```

### Persona and Behavioral Rules (Base Layer)

The base personality and behavioral guidelines are hardcoded string constants:

```javascript
// lib/system-prompt.js
const PERSONA = `You are Riley, a friendly and capable personal assistant.
You help users organize their work, track information, and stay on top of their responsibilities.

Your personality:
- Warm and conversational, but not overly effusive
- Proactive - anticipate what users need
- Transparent - tell users what you're doing and why
- Honest about limitations`;

const BEHAVIORS = `IMPORTANT BEHAVIORS:

ACT DECISIVELY - NEVER ASK UNNECESSARY PERMISSION:
- "Dentist Thursday 3pm" → Create the event immediately, then confirm what you did
- WRONG: "Would you like me to add that?"
- RIGHT: Just do it, then report what you did
...`;
```

### User Profile Layer

The `getUserProfile()` function queries unified memory for identity facts, active projects, and preferences, then formats them into a prompt section. Results are cached for 5 minutes per tenant:

```javascript
// lib/user-profile.js
async function getUserProfile() {
  const sections = [];

  // Identity facts (name, role, timezone)
  const identityFacts = await facts.search('name role timezone occupation', {
    category: 'fact', limit: 10,
  });
  if (identityFacts.length > 0) {
    sections.push(`Identity:\n${identityFacts.slice(0, 5).map(f => `- ${f.content}`).join('\n')}`);
  }

  // Active projects, clients, preferences...
  return sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '';
}
```

### Skill Injection (Dynamic Layer)

Before composing the final prompt, the system searches for skills relevant to the current user message using trigger matching. Matched skills are formatted into a section:

```javascript
let skillsSection = '';
if (userMessage) {
  const relevantSkills = skills.findRelevantSkills(userMessage);
  if (relevantSkills.length > 0) {
    skillsSection = skills.formatForPrompt(relevantSkills);
  }
}
```

The formatted output includes skill names, descriptions, and content bodies under an `## Active Skills` header.

### Vibe Context (Dynamic Layer)

The vibe layer composes three subsystems into a single prompt section:

**Pending Questions** — knowledge gaps detected by the vibe engine, surfaced as questions to weave into conversation:

```javascript
const questions = await vibe.knowledgeGaps.getPendingQuestions(3);
// "QUESTIONS TO EXPLORE (weave naturally into conversation when relevant):
//  - What timezone does the user prefer for scheduling?"
```

**Learned Preferences** — vibes synthesized from observed behavior patterns:

```javascript
const vibeProfile = await vibe.synthesizer.getVibeProfile();
// "LEARNED PREFERENCES (from observed behavior):
//  - Prefers concise responses over detailed explanations"
```

**Confidence Levels** — domain-specific confidence that modulates autonomous behavior:

```javascript
const summary = await vibe.confidence.getConfidenceSummary();
// "YOUR CONFIDENCE LEVELS:
//  Act more autonomously in confident domains.
//  Be more careful and ask more in learning domains."
```

### Anti-Patterns (Appended)

Learned anti-patterns from protocol errors are formatted and appended to prevent recurrence:

```javascript
let antiPatterns = '';
if (includeAntiPatterns) {
  antiPatterns = await formatAntiPatternsForPrompt();
}
```

### Final Assembly

All sections are concatenated using template strings. Empty sections are naturally excluded because empty strings don't contribute visible content:

```javascript
async function generateSystemPrompt(options = {}) {
  const { includeAntiPatterns = true, userMessage, activeSkills } = options;

  const capabilityContext = capabilityManifest.generateLLMContext();
  const antiPatterns = includeAntiPatterns ? await formatAntiPatternsForPrompt() : '';
  const skillsSection = /* ... trigger matching ... */;
  const userProfile = await getUserProfile();
  const vibeContext = await getVibeContext();

  return `${PERSONA}
${userProfile}
${BEHAVIORS}

${capabilityContext}${antiPatterns}${skillsSection}${vibeContext}

Remember: Users trust you to actually do things, not just describe what you could do.`;
}
```

Note the assembly uses direct template string concatenation, not `---` separators between sections. This keeps the prompt format natural for the LLM.

### Sync Fallback

A synchronous version is available for contexts where async isn't possible, omitting anti-patterns, skills, user profile, and vibe context:

```javascript
function getSystemPromptSync() {
  const capabilityContext = capabilityManifest.generateLLMContext();
  return `${PERSONA}\n\n${BEHAVIORS}\n\n${capabilityContext}\n\n...`;
}
```

## Implications

- The prompt varies per message — skill injection adapts to message content, vibe context adapts to operational history
- Template string concatenation (not `---` delimiters) keeps the format natural — empty sections don't leave visible markers
- The user profile layer adds personalization but depends on unified memory being populated — a fresh instance has no profile context
- The vibe subsystem creates a feedback loop: operational outcomes adjust confidence, which adjusts the prompt, which adjusts agent behavior
- Domain confidence levels make the agent more autonomous in high-confidence areas and more cautious in low-confidence ones
- Each dynamic section has its own try/catch with `logger.warn` — a failure in any one section degrades the prompt but doesn't crash composition
- The sync fallback ensures the prompt is always available, even if degraded, for non-async code paths
- Anti-patterns grow over time and need periodic pruning to stay within token budgets
- Multiple async fetches per dispatch (skills, anti-patterns, user profile, vibe) add latency — results are not parallelized in the current implementation

## Code Example

```javascript
// Full dispatch with dynamic prompt composition
const { getSystemPrompt } = require('./lib/system-prompt');

async function dispatch(message, conversation) {
  const systemPrompt = await getSystemPrompt({
    userMessage: message.text,
    includeAntiPatterns: true,
  });

  const response = await model.generate({
    systemInstruction: systemPrompt,
    contents: conversation.messages,
    tools: capabilities.getDeclarations(),
  });

  return response;
}

// The generated prompt structure:
// 1. PERSONA — "You are Riley, a friendly..."
// 2. USER PROFILE — "Identity: Mike, Eastern timezone..."
// 3. BEHAVIORS — "ACT DECISIVELY..."
// 4. CAPABILITY MANIFEST — tool categories and descriptions
// 5. ANTI-PATTERNS — "DO NOT: call entity() without searching first"
// 6. ACTIVE SKILLS — matched skill content for current message
// 7. VIBE CONTEXT — questions, preferences, confidence levels
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
