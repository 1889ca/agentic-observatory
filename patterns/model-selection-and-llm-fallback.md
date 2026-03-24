# Model Selection and LLM Fallback

> Route requests to the best-fit model based on task requirements, with provider-level fallback when a provider is unavailable.

## Problem

Relying on a single LLM model for all tasks is wasteful and brittle. Simple tasks don't need the most capable (and expensive) model; complex tasks may produce poor results on a cheaper one. Selecting models by rote — always primary, then fallback — ignores the actual requirements of each request. And eagerly initializing all provider clients wastes resources for providers that may never be called.

## Context

- Multiple LLM providers and models available (Anthropic, OpenAI, etc.)
- Tasks vary widely in complexity, latency requirements, and cost sensitivity
- Provider initialization is expensive and should be deferred to first use
- Fallback is needed at the provider level (if Anthropic is unreachable, try OpenAI), not the model level
- A central config defines what models exist; a router decides which one to use

## Solution

Split model management into two layers. A config module declares the catalog of available models — each entry specifies provider, capability tier, cost tier, context window, and any other properties the router needs to reason about. A router module accepts a task descriptor and selects the best model from the catalog based on those requirements. Provider clients are initialized lazily on first use with a simple flag-based guard to avoid duplicate initialization — no mutex-promise chain needed.

```javascript
// config/models.js — illustrative
// Defines the catalog; does not initialize any clients
const MODELS = [
  {
    id: 'claude-opus',
    provider: 'anthropic',
    capabilities: ['reasoning', 'long-context', 'code'],
    costTier: 'high',
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku',
    provider: 'anthropic',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'low',
    contextWindow: 48_000,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['reasoning', 'code', 'vision'],
    costTier: 'high',
    contextWindow: 128_000,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: ['summarization', 'classification', 'fast'],
    costTier: 'low',
    contextWindow: 128_000,
  },
];

module.exports = { MODELS };
```

```javascript
// lib/llm/router.js — illustrative
const { MODELS } = require('../../config/models');

// Lazy-initialized provider clients — keyed by provider name
const clients = {};
const initializing = {};

async function getClient(provider) {
  if (clients[provider]) return clients[provider];

  // Flag-based guard: if init is already in progress, wait for it
  if (initializing[provider]) return initializing[provider];

  initializing[provider] = initProvider(provider).then(client => {
    clients[provider] = client;
    delete initializing[provider];
    return client;
  });

  return initializing[provider];
}

function selectModel(task) {
  // task: { complexity, costSensitive, speedRequired, contextLength }
  const candidates = MODELS.filter(m => {
    if (task.contextLength && m.contextWindow < task.contextLength) return false;
    if (task.speedRequired && !m.capabilities.includes('fast')) return false;
    return true;
  });

  if (task.costSensitive) {
    // Prefer low-cost models that meet requirements
    const cheap = candidates.filter(m => m.costTier === 'low');
    if (cheap.length) return cheap[0];
  }

  if (task.complexity === 'high') {
    return candidates.find(m => m.capabilities.includes('reasoning')) ?? candidates[0];
  }

  return candidates[0];
}

async function complete(task, prompt, options = {}) {
  const model = selectModel(task);

  try {
    const client = await getClient(model.provider);
    return await client.complete(model.id, prompt, options);
  } catch (err) {
    // Provider-level fallback: try the same task requirements on a different provider
    const fallbackModel = MODELS.find(
      m => m.provider !== model.provider && m.capabilities.includes('reasoning')
    );
    if (!fallbackModel) throw err;

    logger.warn(`Provider ${model.provider} failed, falling back to ${fallbackModel.provider}`);
    const fallbackClient = await getClient(fallbackModel.provider);
    return fallbackClient.complete(fallbackModel.id, prompt, options);
  }
}

module.exports = { complete, selectModel };
```

## Implications

- The config/router split means adding a new model requires only a catalog entry — routing logic does not change
- Task-based selection means callers must describe what they need (complexity, cost, speed), not which model to use — this is intentional and forces callers to stay decoupled from model identities
- Provider-level fallback is coarser than model-level fallback: the entire provider must fail before the fallback activates, which is appropriate for infrastructure-level outages but won't help if a specific model is rate-limited
- Lazy init shifts cold-start cost to first use; the flag-based guard prevents duplicate inits without the complexity of a mutex-promise chain
- Model capability declarations in config must be kept accurate — stale entries will cause the router to make poor selections silently

## Code Example

```javascript
// Caller describes the task, not the model — illustrative
const result = await router.complete(
  { complexity: 'high', costSensitive: false, contextLength: 50_000 },
  'Analyze this codebase and identify architectural risks',
  { maxTokens: 2048 }
);

// Low-stakes task — router picks a fast, cheap model
const summary = await router.complete(
  { complexity: 'low', costSensitive: true, speedRequired: true },
  'Summarize this support ticket in one sentence',
  { maxTokens: 128 }
);
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
