# Retry Utility with Non-Retryable Detection

> Generic retry wrapper with configurable backoff that skips retries for errors that cannot succeed on retry.

## Problem

Network calls, LLM API requests, and external service interactions fail transiently. Naive retry logic wastes time retrying errors that will never succeed (authentication failures, 404s, validation errors), while no retry logic means transient failures propagate unnecessarily.

## Context

Riley makes many external API calls -- to LLM providers, webhooks, storage backends, and third-party services. Each call can fail for transient reasons (rate limits, timeouts, network blips) or permanent reasons (bad credentials, missing resources). A single retry utility standardizes this behavior across the entire system.

## Solution

A `makeRetryable()` wrapper function that accepts any async function and returns a retrying version. It uses configurable exponential backoff with a list of non-retryable error patterns that short-circuit the retry loop.

```js
function makeRetryable(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    backoffMultiplier = 2,
    nonRetryable = [/401/, /403/, /404/, /Invalid API key/i]
  } = options;

  return async function (...args) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        lastError = err;
        const msg = err.message || String(err);
        if (nonRetryable.some(pattern => pattern.test(msg))) throw err;
        if (attempt < maxRetries) {
          await sleep(baseDelay * Math.pow(backoffMultiplier, attempt));
        }
      }
    }
    throw lastError;
  };
}
```

Key behaviors:

- **Exponential backoff** -- delay doubles on each attempt (1s, 2s, 4s by default)
- **Non-retryable pattern matching** -- auth failures (401/403), not found (404), and known permanent errors skip retries immediately
- **Configurable per call site** -- each caller can override max retries, delays, and non-retryable patterns
- **Transparent wrapping** -- the retryable version has the same signature as the original function

## Implications

- **Consistent retry behavior** -- all external calls follow the same retry strategy without duplicating logic
- **Fast failure for permanent errors** -- non-retryable detection prevents wasting time on errors that cannot self-heal
- **Composable** -- can wrap any async function regardless of its signature
- **No circuit breaker** -- does not track failure rates across calls; each invocation is independent

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
