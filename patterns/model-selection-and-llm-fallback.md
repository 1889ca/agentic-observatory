# Model Selection and LLM Fallback

> Task-type and feature-name based routing across a three-provider stack (Gemini primary, Claude for complex reasoning, OpenAI optional) using flat key-value config with date-suffixed Claude model IDs and complexity-based escalation.

## Problem

Relying on a single LLM model for all tasks is wasteful and brittle. Simple tasks don't need the most capable (and expensive) model; complex tasks may produce poor results on a cheaper one. Beyond basic cost/capability selection, different execution contexts need different models: interactive chat demands low latency, background workers prioritize cost efficiency, and deep analysis requires extended thinking. A flat model list doesn't capture these role distinctions.

## Context

- Three LLM providers: Google (Gemini) as primary, Anthropic (Claude) for complex reasoning, OpenAI for specialized tasks
- Model configuration uses flat key-value exports (not a `MODELS` array of objects)
- Claude model IDs include date suffixes (e.g., `claude-sonnet-4-20250514`, not just `claude-sonnet-4`)
- The router selects models based on task type, feature name, and complexity score — not just a "role" field
- OpenAI models exist in config but are disabled by default
- Provider initialization is expensive and should be deferred to first use

## Solution

### Flat Key-Value Model Config

Models are configured as individual named exports, each with an environment variable override. This is a flat key-value structure, not an array of model objects:

```javascript
// lib/config/models.js
module.exports = {
  // Gemini models
  MAIN_MODEL: process.env.RILEY_MAIN_MODEL || 'gemini-2.5-flash',
  WORKER_MODEL: process.env.RILEY_WORKER_MODEL || 'gemini-2.5-flash-lite',
  FALLBACK_MODEL: process.env.RILEY_FALLBACK_MODEL || 'gemini-2.5-flash-lite',
  EXTRACTION_MODEL: process.env.RILEY_EXTRACTION_MODEL || 'gemini-2.5-flash-lite',
  THINKING_MODEL: process.env.RILEY_THINKING_MODEL || 'gemini-3-pro-preview',

  // Claude models (note date suffixes)
  CLAUDE_MODEL: process.env.RILEY_CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  CLAUDE_ADVANCED_MODEL: process.env.RILEY_CLAUDE_ADVANCED_MODEL || 'claude-opus-4-20250514',
  CLAUDE_FAST_MODEL: process.env.RILEY_CLAUDE_FAST_MODEL || 'claude-3-5-haiku-20241022',

  // OpenAI models
  OPENAI_MODEL: process.env.RILEY_OPENAI_MODEL || 'gpt-4o',
  OPENAI_FAST_MODEL: process.env.RILEY_OPENAI_FAST_MODEL || 'gpt-4o-mini',
  OPENAI_ADVANCED_MODEL: process.env.RILEY_OPENAI_ADVANCED_MODEL || 'o1',

  // Routing config
  CLAUDE_ENABLED: process.env.RILEY_CLAUDE_ENABLED !== 'false',
  OPENAI_ENABLED: process.env.RILEY_OPENAI_ENABLED === 'true',
  CLAUDE_COMPLEXITY_THRESHOLD: parseFloat(process.env.RILEY_CLAUDE_COMPLEXITY_THRESHOLD || '0.8'),
};
```

### Task-Type + Feature-Name Routing

The router uses a multi-level decision tree that checks task type AND feature name, not just a generic "role":

```javascript
// lib/llm/router.js
const ROUTING_RULES = {
  taskTypes: {
    chat:           { provider: 'gemini', tier: 'standard' },
    extraction:     { provider: 'gemini', tier: 'fast' },
    classification: { provider: 'gemini', tier: 'fast' },
    summarization:  { provider: 'gemini', tier: 'fast' },
    planning:       { provider: 'claude', tier: 'standard' },
    reflection:     { provider: 'claude', tier: 'standard' },
    code_analysis:  { provider: 'claude', tier: 'advanced' },
  },

  models: {
    gemini: { fast: models.FALLBACK_MODEL, standard: models.MAIN_MODEL, advanced: models.THINKING_MODEL },
    claude: { fast: models.CLAUDE_FAST_MODEL, standard: models.CLAUDE_MODEL, advanced: models.CLAUDE_ADVANCED_MODEL },
    openai: { fast: models.OPENAI_FAST_MODEL, standard: models.OPENAI_MODEL, advanced: models.OPENAI_ADVANCED_MODEL },
  },
};
```

### Feature-Specific Routing Sets

Certain features are pinned to specific providers regardless of task type. Two `Set` objects define these:

```javascript
const CLAUDE_REQUIRED_FEATURES = new Set([
  'goal_decomposition', 'strategy_planning', 'weekly_synthesis',
  'belief_formation', 'code_review', 'architecture_planning',
  'objective_review', 'daily_reflection',
]);

const GEMINI_PREFERRED_FEATURES = new Set([
  'email_triage', 'entity_extraction', 'fact_extraction',
  'topic_extraction', 'conversation_summary', 'morning_briefing',
  'classification', 'translation', 'event_analysis', 'correction_extraction',
]);
```

### Routing Decision Tree

The router evaluates in strict priority order:

```javascript
function route(request) {
  const { taskType, featureName, complexity, preferClaude, preferGemini, preferOpenAI } = request;

  // 0. Extended thinking request → Claude advanced
  if (request.claudeExtendedThinking && claude.isAvailable()) {
    return { provider: 'claude', model: models.claude.advanced, reason: 'extended_thinking' };
  }

  // 0.5. Fast model preference
  if (request.preferFastModel) {
    return { provider: 'gemini', model: models.gemini.fast, reason: 'fast_model_preference' };
  }

  // 1-3. Explicit provider preferences (Gemini, OpenAI, Claude)
  if (preferGemini) return { provider: 'gemini', model: models.gemini.standard };
  if (preferOpenAI && openai.isAvailable()) return { provider: 'openai', model: models.openai.standard };
  if (preferClaude && claude.isAvailable()) return { provider: 'claude', model: models.claude.standard };

  // 4. Feature-specific routing
  if (featureName && CLAUDE_REQUIRED_FEATURES.has(featureName) && claude.isAvailable()) {
    return { provider: 'claude', model: models.claude.standard, reason: 'feature_requires_claude' };
  }
  if (featureName && GEMINI_PREFERRED_FEATURES.has(featureName)) {
    return { provider: 'gemini', model: models.gemini.fast, reason: 'feature_prefers_gemini' };
  }

  // 5. Task type routing
  if (taskType && ROUTING_RULES.taskTypes[taskType]) {
    const rule = ROUTING_RULES.taskTypes[taskType];
    return { provider: rule.provider, model: models[rule.provider][rule.tier] };
  }

  // 6. Complexity-based routing
  const estimatedComplexity = complexity ?? estimateComplexity(request);
  if (estimatedComplexity >= CLAUDE_COMPLEXITY_THRESHOLD && claude.isAvailable()) {
    return { provider: 'claude', model: models.claude.standard, reason: 'high_complexity' };
  }

  // 7. Default to Gemini with complexity-based tier
  return { provider: 'gemini', model: models.gemini.standard, reason: 'default_routing' };
}
```

### Complexity Estimation

For requests without an explicit complexity score, the router estimates complexity using prompt length and pattern matching:

```javascript
function estimateComplexity(request) {
  let score = 0.5;
  const prompt = request.prompt || '';

  if (prompt.length > 5000) score += 0.1;
  if (prompt.length > 10000) score += 0.1;

  // Multi-step reasoning indicators boost complexity
  const complexPatterns = [/trade.?off/i, /step.?by.?step/i, /architecture|design/i, /comprehensive/i];
  for (const p of complexPatterns) if (p.test(prompt)) score += 0.05;

  // Simple task indicators reduce complexity
  const simplePatterns = [/^(what|when|where|who) is/i, /summarize/i, /classify/i];
  for (const p of simplePatterns) if (p.test(prompt)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}
```

### Convenience Methods

The LLM module exposes semantic shortcuts that map to routing parameters:

```javascript
// Quick generation (Gemini fast, extraction task type)
async function quick(prompt, options = {}) {
  return generate({ prompt, preferGemini: true, taskType: 'extraction', model: models.FALLBACK_MODEL, ...options });
}

// Deep thinking (Claude, planning task type)
async function think(prompt, options = {}) {
  return generate({ prompt, preferClaude: true, taskType: 'planning', ...options });
}
```

## Implications

- Flat key-value config means model IDs are accessed as `models.CLAUDE_MODEL` rather than searching an array — simpler to consume but less queryable than a structured model registry
- Date-suffixed Claude model IDs (`claude-sonnet-4-20250514`) mean config must be updated when new model versions release — there's no automatic "latest" resolution
- Feature-name routing creates hard dependencies between business logic and LLM routing — adding a new feature that needs Claude requires updating the `CLAUDE_REQUIRED_FEATURES` set
- The routing decision tree has 8 priority levels — feature-specific routing (level 4) overrides task-type routing (level 5), which overrides complexity (level 6)
- Complexity estimation is heuristic-based with prompt length and pattern matching — it's fast but imprecise, particularly for short prompts with complex intent
- The `CLAUDE_COMPLEXITY_THRESHOLD` defaults to 0.8, meaning only clearly complex requests escalate — this keeps Claude costs low
- All env vars follow the `RILEY_` prefix convention, making it clear which config belongs to the orchestrator

## Code Example

```javascript
const llm = require('./lib/llm');

// Interactive chat — routes to Gemini 2.5 Flash via task type
const reply = await llm.generate({
  prompt: 'What meetings do I have today?',
  taskType: 'chat',
});
// routing: { provider: 'gemini', model: 'gemini-2.5-flash', reason: 'task_type_routing' }

// Email triage — routes to Gemini fast via feature name
const triage = await llm.generate({
  prompt: 'Classify these 50 emails',
  featureName: 'email_triage',
});
// routing: { provider: 'gemini', model: 'gemini-2.5-flash-lite', reason: 'feature_prefers_gemini' }

// Code review — routes to Claude via feature name
const review = await llm.generate({
  prompt: 'Review this pull request for architectural issues',
  featureName: 'code_review',
});
// routing: { provider: 'claude', model: 'claude-sonnet-4-20250514', reason: 'feature_requires_claude' }

// Quick extraction (convenience method)
const entities = await llm.quick('Extract names from: "Meeting with Sarah and Mike"');

// Deep thinking (convenience method)
const strategy = await llm.think('Design a migration plan for the billing service');
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [LLM Adapter Facade](./llm-adapter-facade.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
