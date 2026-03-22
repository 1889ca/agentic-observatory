# Model Selection and LLM Fallback

> Primary/fallback LLM provider chain with lazy initialization, concurrent init prevention, and timeout protection.

## Problem

Relying on a single LLM provider means any outage, rate limit, or timeout takes the entire agent offline. Eagerly initializing all providers wastes resources and slows startup for providers that may never be needed. And when multiple requests arrive during initialization, concurrent init attempts can create duplicate clients, race conditions, or wasted API calls.

## Context

- Multiple LLM providers available (OpenAI, Anthropic, Google, local models)
- Primary provider handles most traffic; fallback activates only on failure
- Provider initialization is expensive (API key validation, model listing, connection setup)
- High-concurrency environments where multiple requests may trigger init simultaneously
- Model calls need timeout protection to prevent hanging requests

## Solution

A model manager maintains a provider chain with lazy initialization. Each provider is initialized on first use, not at startup. A mutex flag prevents concurrent initialization — if init is already in progress, subsequent callers wait for the same Promise rather than starting a second init. Model calls are wrapped in timeout protection to prevent indefinite hangs.

```javascript
// model-manager.js
class ModelManager {
  constructor(providerConfigs) {
    this.providers = providerConfigs.map(cfg => ({
      name: cfg.name,
      factory: cfg.factory,
      timeout: cfg.timeout || 30_000,
      client: null,
      initializing: null, // Mutex: Promise while init in progress
    }));
  }

  async getProvider(name) {
    const provider = this.providers.find(p => p.name === name);
    if (!provider) throw new Error(`Unknown provider: ${name}`);

    if (provider.client) return provider.client;

    // Concurrent init prevention — reuse in-flight init Promise
    if (provider.initializing) return provider.initializing;

    provider.initializing = provider.factory()
      .then(client => { provider.client = client; return client; })
      .finally(() => { provider.initializing = null; });

    return provider.initializing;
  }

  async complete(prompt, options = {}) {
    for (const provider of this.providers) {
      try {
        const client = await this.getProvider(provider.name);
        return await withTimeout(
          client.complete(prompt, options),
          provider.timeout
        );
      } catch (err) {
        logger.warn(`Provider ${provider.name} failed, trying next`, { error: err.message });
        provider.client = null; // Reset for re-init on next attempt
        continue;
      }
    }
    throw new Error('All LLM providers exhausted');
  }
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
```

## Implications

- Lazy init means the first request to a provider pays the init cost — cold start latency is shifted from startup to first use
- The mutex flag prevents duplicate clients but means concurrent callers share the same init failure if it occurs
- Resetting `client` to null on failure forces re-initialization on the next attempt, which handles transient init failures but adds latency
- Timeout values need tuning per provider — local models respond faster than remote APIs, streaming responses need longer timeouts than single completions
- The fallback chain is ordered by preference, not by latency — a slow primary will be tried (and timed out) before a fast fallback

## Code Example

```javascript
// Setup with primary and fallback providers
const models = new ModelManager([
  { name: 'anthropic', factory: () => initAnthropic(process.env.ANTHROPIC_KEY), timeout: 30_000 },
  { name: 'openai', factory: () => initOpenAI(process.env.OPENAI_KEY), timeout: 25_000 },
]);

// Usage — automatically falls back on failure
const response = await models.complete('Summarize this document', {
  maxTokens: 1024,
  temperature: 0.3,
});
```

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
