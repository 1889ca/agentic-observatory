# Model Selection and LLM Fallback

> Role-based model routing across a three-provider stack (Gemini primary, Claude for complex reasoning, OpenAI optional) with separate model assignments for interactive chat, background workers, and deep thinking.

## Problem

Relying on a single LLM model for all tasks is wasteful and brittle. Simple tasks don't need the most capable (and expensive) model; complex tasks may produce poor results on a cheaper one. Beyond basic cost/capability selection, different execution contexts need different models: interactive chat demands low latency, background workers prioritize cost efficiency, and deep analysis requires extended thinking capabilities. A flat model list doesn't capture these role distinctions.

## Context

- Three LLM providers: Google (Gemini) as primary, Anthropic (Claude) for complex reasoning, OpenAI for specialized tasks
- Distinct execution roles: interactive chat (MAIN_MODEL), background processing (WORKER_MODEL), deep analysis (THINKING_MODEL)
- Each provider has multiple model tiers — the config assigns specific models to specific roles
- OpenAI models exist in config but are **disabled by default** — require `RILEY_OPENAI_ENABLED=true` to activate
- Provider initialization is expensive and should be deferred to first use
- A central config defines role-to-model mappings; a router resolves the role at dispatch time

## Solution

The config module defines named model roles rather than a flat capability list. Each role maps to a specific model ID, and the router selects by role first, then falls back across providers if the primary fails. Provider clients are initialized lazily on first use with a singleton promise guard and a 30-second timeout.

### Role-Based Model Config

```javascript
// config/models.js — illustrative
const MAIN_MODEL = 'gemini-2.5-flash';        // Interactive chat — fast, cost-effective
const WORKER_MODEL = 'gemini-2.5-flash-lite';  // Background tasks — cheapest option
const THINKING_MODEL = 'gemini-3-pro-preview'; // Deep analysis — extended thinking

const MODELS = [
  // Google (Gemini) — primary provider
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    role: 'main',
    capabilities: ['reasoning', 'code', 'fast'],
    costTier: 'low',
    contextWindow: 1_000_000,
    enabled: true,
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'google',
    role: 'worker',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'lowest',
    contextWindow: 1_000_000,
    enabled: true,
  },
  {
    id: 'gemini-3-pro-preview',
    provider: 'google',
    role: 'thinking',
    capabilities: ['reasoning', 'analysis', 'long-context'],
    costTier: 'medium',
    contextWindow: 1_000_000,
    enabled: true,
  },

  // Anthropic (Claude) — complex reasoning and code
  {
    id: 'claude-sonnet-4',
    provider: 'anthropic',
    role: 'complex',
    capabilities: ['reasoning', 'long-context', 'code'],
    costTier: 'high',
    contextWindow: 200_000,
    enabled: true,
  },
  {
    id: 'claude-opus-4',
    provider: 'anthropic',
    role: 'advanced',
    capabilities: ['reasoning', 'analysis', 'code'],
    costTier: 'highest',
    contextWindow: 200_000,
    enabled: true,
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    role: 'fast-reasoning',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'low',
    contextWindow: 200_000,
    enabled: true,
  },

  // OpenAI — disabled by default
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['reasoning', 'code', 'vision'],
    costTier: 'high',
    contextWindow: 128_000,
    enabled: process.env.RILEY_OPENAI_ENABLED === 'true',
  },
  {
    id: 'o1',
    provider: 'openai',
    role: 'advanced',
    capabilities: ['reasoning', 'analysis'],
    costTier: 'highest',
    contextWindow: 200_000,
    enabled: process.env.RILEY_OPENAI_ENABLED === 'true',
  },
];
```

### Role-Based Routing

The router resolves execution context to a model role, then selects from enabled models:

```javascript
// lib/llm/router.js — illustrative
function selectModel(task) {
  const candidates = activeModels();

  // Role-based selection: worker tasks get the worker model
  if (task.role === 'worker') {
    return candidates.find(m => m.id === WORKER_MODEL) ?? candidates[0];
  }

  // Deep thinking tasks get the thinking model
  if (task.requiresThinking) {
    return candidates.find(m => m.id === THINKING_MODEL) ?? candidates[0];
  }

  // Complex reasoning escalates to Claude
  if (task.complexity === 'high') {
    return candidates.find(m => m.role === 'complex') ?? candidates[0];
  }

  // Default: main interactive model (Gemini Flash)
  return candidates.find(m => m.id === MAIN_MODEL) ?? candidates[0];
}
```

### Provider-Level Fallback

When a provider fails entirely, the router falls back across providers. Gemini failure routes to Claude; Claude failure routes to Gemini. OpenAI serves as a tertiary fallback when enabled:

```javascript
async function complete(task, prompt, options = {}) {
  const model = selectModel(task);

  try {
    const client = await getClient(model.provider);
    return await client.complete(model.id, prompt, options);
  } catch (err) {
    // Cross-provider fallback
    const fallback = activeModels().find(
      m => m.provider !== model.provider && m.capabilities.includes('reasoning')
    );
    if (!fallback) throw err;

    logger.warn(`${model.provider} failed, falling back to ${fallback.provider}`);
    const client = await getClient(fallback.provider);
    return client.complete(fallback.id, prompt, options);
  }
}
```

## Implications

- Gemini is the primary provider for both interactive and worker tasks — Claude handles complex reasoning escalation
- The worker model (Flash-lite) is distinct from the main model (Flash), enabling cost optimization for background processing without affecting chat quality
- The thinking model (Gemini 3 Pro) is a separate role for deep analysis, not just a "bigger" version of the main model
- Three-provider stack provides resilience: Google down → Anthropic fallback → OpenAI tertiary (if enabled)
- Role-based selection means callers specify intent (`worker`, `thinking`, `complex`) rather than model names
- Lazy init with singleton promise guard prevents duplicate initialization; 30-second timeout prevents indefinite hangs
- OpenAI requires explicit opt-in via `RILEY_OPENAI_ENABLED=true` — kept in config for easy activation

## Code Example

```javascript
// Interactive chat — routes to Gemini 2.5 Flash
const reply = await router.complete(
  { role: 'main' },
  'What meetings do I have today?',
  { maxTokens: 512 }
);

// Background worker task — routes to Gemini 2.5 Flash-lite
const summary = await router.complete(
  { role: 'worker', costSensitive: true },
  'Summarize these 50 support tickets',
  { maxTokens: 256 }
);

// Complex reasoning — escalates to Claude Sonnet
const analysis = await router.complete(
  { complexity: 'high' },
  'Analyze this codebase architecture and identify coupling risks',
  { maxTokens: 2048 }
);

// Deep thinking — routes to Gemini 3 Pro preview
const strategy = await router.complete(
  { requiresThinking: true },
  'Design a migration plan for moving from monolith to microservices',
  { maxTokens: 4096 }
);
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [LLM Adapter Facade](./llm-adapter-facade.md)
