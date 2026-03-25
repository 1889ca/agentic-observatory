# Model Selection and LLM Fallback

> Route requests to the best-fit model from a Claude + Gemini stack, with Gemini Flash-lite as the cost-effective fallback and OpenAI available but disabled by default.

## Problem

Relying on a single LLM model for all tasks is wasteful and brittle. Simple tasks don't need the most capable (and expensive) model; complex tasks may produce poor results on a cheaper one. Selecting models by rote — always primary, then fallback — ignores the actual requirements of each request. And eagerly initializing all provider clients wastes resources for providers that may never be called.

## Context

- Two active LLM providers: Anthropic (Claude) as primary, Google (Gemini) as fallback
- OpenAI models exist in config but are **disabled by default** — require `RILEY_OPENAI_ENABLED=true` to activate
- Tasks vary widely in complexity, latency requirements, and cost sensitivity
- Provider initialization is expensive and should be deferred to first use
- Gemini Flash-lite serves as the real cost-effective fallback, not OpenAI
- A central config defines what models exist; a router decides which one to use

## Solution

Split model management into two layers. A config module declares the catalog of available models — each entry specifies provider, capability tier, cost tier, context window, and an `enabled` flag. A router module accepts a task descriptor and selects the best model from enabled entries. Provider clients are initialized lazily on first use with a singleton promise guard (`modelInitPromise`) and a 30-second timeout to prevent indefinite hangs.

```javascript
// config/models.js — illustrative
const MODELS = [
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    capabilities: ['reasoning', 'long-context', 'code'],
    costTier: 'high',
    contextWindow: 200_000,
    enabled: true,
  },
  {
    id: 'claude-haiku',
    provider: 'anthropic',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'low',
    contextWindow: 200_000,
    enabled: true,
  },
  {
    id: 'gemini-flash',
    provider: 'google',
    capabilities: ['reasoning', 'code', 'fast'],
    costTier: 'medium',
    contextWindow: 1_000_000,
    enabled: true,
  },
  {
    id: 'gemini-flash-lite',
    provider: 'google',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'low',
    contextWindow: 1_000_000,
    enabled: true,  // Real fallback for cost-sensitive tasks
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['reasoning', 'code', 'vision'],
    costTier: 'high',
    contextWindow: 128_000,
    enabled: process.env.RILEY_OPENAI_ENABLED === 'true',  // Disabled by default
  },
];
```

```javascript
// lib/llm/router.js — illustrative
const { MODELS } = require('../../config/models');

// Only consider enabled models
const activeModels = () => MODELS.filter(m => m.enabled);

// Lazy singleton init with concurrency guard and timeout
let modelInitPromise = null;
const clients = {};

async function getClient(provider) {
  if (clients[provider]) return clients[provider];

  if (!modelInitPromise) {
    modelInitPromise = Promise.race([
      initProvider(provider),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Model init timeout (30s)')), 30_000)
      ),
    ]).then(client => {
      clients[provider] = client;
      modelInitPromise = null;
      return client;
    });
  }

  return modelInitPromise;
}

function selectModel(task) {
  const candidates = activeModels().filter(m => {
    if (task.contextLength && m.contextWindow < task.contextLength) return false;
    if (task.speedRequired && !m.capabilities.includes('fast')) return false;
    return true;
  });

  if (task.costSensitive) {
    const cheap = candidates.filter(m => m.costTier === 'low');
    if (cheap.length) return cheap[0]; // Gemini Flash-lite typically wins here
  }

  if (task.complexity === 'high') {
    return candidates.find(m => m.capabilities.includes('reasoning')) ?? candidates[0];
  }

  return candidates[0]; // Claude Sonnet as default
}

async function complete(task, prompt, options = {}) {
  const model = selectModel(task);

  try {
    const client = await getClient(model.provider);
    return await client.complete(model.id, prompt, options);
  } catch (err) {
    // Provider-level fallback: Anthropic fails → try Google (Gemini)
    const fallbackModel = activeModels().find(
      m => m.provider !== model.provider && m.capabilities.includes('reasoning')
    );
    if (!fallbackModel) throw err;

    logger.warn(`Provider ${model.provider} failed, falling back to ${fallbackModel.provider}`);
    const fallbackClient = await getClient(fallbackModel.provider);
    return fallbackClient.complete(fallbackModel.id, prompt, options);
  }
}
```

## Implications

- The active stack is Claude + Gemini — OpenAI requires explicit opt-in via environment variable
- Gemini Flash-lite is the real cost-effective fallback for simple tasks, not GPT-4o-mini
- The config/router split means adding a new model requires only a catalog entry with `enabled: true`
- Task-based selection forces callers to describe requirements, not model names
- Provider-level fallback is coarser than model-level: the entire provider must fail before fallback activates
- Lazy init with `modelInitPromise` singleton prevents duplicate initialization; 30-second timeout prevents indefinite hangs on first use
- The `enabled` flag pattern allows models to exist in config for easy activation without code changes

## Code Example

```javascript
// High-complexity task — routes to Claude Sonnet
const result = await router.complete(
  { complexity: 'high', costSensitive: false, contextLength: 50_000 },
  'Analyze this codebase and identify architectural risks',
  { maxTokens: 2048 }
);

// Cost-sensitive task — routes to Gemini Flash-lite
const summary = await router.complete(
  { complexity: 'low', costSensitive: true, speedRequired: true },
  'Summarize this support ticket in one sentence',
  { maxTokens: 128 }
);
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Lazy Model Initialization](./lazy-model-initialization.md)
