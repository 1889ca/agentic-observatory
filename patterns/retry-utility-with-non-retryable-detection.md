# Retry Utility with Non-Retryable Detection

> Layered retry system with HTTP status code checks, error code matching, regex pattern detection, `onRetry` callbacks, and a circuit breaker for rate-limited APIs.

## Problem

Network calls, LLM API requests, and external service interactions fail transiently. Naive retry logic wastes time retrying errors that will never succeed (authentication failures, 404s, validation errors), while no retry logic means transient failures propagate unnecessarily. Rate-limited APIs need additional protection -- repeated retries against a throttled endpoint can trigger longer lockouts.

## Context

Riley makes many external API calls -- to LLM providers (Gemini), webhooks, storage backends, Gmail, and third-party services. Each call can fail for transient reasons (rate limits, timeouts, server errors) or permanent reasons (bad credentials, missing resources). Two retry utilities standardize this behavior: a general-purpose `withRetry` for arbitrary async operations, and a specialized `retryWithBackoff` for LLM API calls with circuit breaker protection.

## Solution

### General-Purpose Retry (`lib/retry.js`)

The primary API is `withRetry(fn, config)`, which executes an async function with configurable retry logic. Non-retryable detection uses three checks in sequence:

1. **HTTP status codes** -- checks `error.response.status` against a configurable list (default: 400, 401, 403, 404, 422)
2. **Error codes** -- checks `error.code` for both numeric HTTP codes and string codes like `ENOTFOUND` and `ECONNREFUSED`
3. **Regex patterns** -- matches `error.message` against configurable patterns for auth/credential failures

```js
const { withRetry } = require('./lib/retry');

const result = await withRetry(
  () => fetchExternalData(url),
  {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    nonRetryableStatusCodes: [400, 401, 403, 404, 422],
    nonRetryableErrorPatterns: [/invalid.*credentials?/i, /unauthorized/i],
    onRetry: (attemptNumber, error, delay) => {
      logger.warn({ attempt: attemptNumber, delayMs: delay }, 'Retrying');
    },
  }
);
```

Key behaviors:

- **Three-layer non-retryable detection** -- HTTP status codes, error codes (`error.code`), and regex patterns are all checked before deciding to retry
- **`onRetry` callback** -- called before each retry with the attempt number, error, and delay, enabling logging or metrics without modifying the retry logic
- **Capped exponential backoff** -- delay doubles per attempt but never exceeds `maxDelayMs` (default 30s)
- **`makeRetryable()` wrapper** -- creates a pre-configured retryable version of any function: `const safeFetch = makeRetryable(fetch, config)`

### LLM Rate Limit Retry (`lib/message-processor/retry.js`)

A specialized retry for Gemini API calls that adds circuit breaker protection and adaptive backoff:

```js
const { retryWithBackoff } = require('./lib/message-processor/retry');

const response = await retryWithBackoff(() => gemini.generateContent(prompt), 3);
```

This layer adds:

- **Circuit breaker** -- tracks rate limit events in a sliding window (default 1 minute). After 3 rate limits in the window, forces a 10-second cooldown before any new requests
- **Adaptive backoff** -- scales delay based on consecutive failure count, not just attempt number
- **Retry-After parsing** -- extracts delay hints from error messages (e.g., "retry in 30s") and uses them instead of calculated backoff
- **Request spacing** -- enforces a minimum 500ms gap between requests to prevent burst-triggered throttling

### How They Compose

The general-purpose `withRetry` is used throughout the codebase -- webhook delivery, Gmail API calls, agent recovery strategies. The specialized `retryWithBackoff` is used only for the LLM message processing path where rate limiting is the dominant failure mode. Agent recovery strategies use `withRetry` with custom `onRetry` callbacks for observability:

```js
return withRetry(executor, {
  ...RETRY_CONFIGS[errorType],
  onRetry: (attempt, err, delay) => {
    logger.info({ attempt, delayMs: delay, err }, 'Recovery retry');
  },
});
```

## Implications

- **Consistent retry behavior** -- all external calls follow the same retry strategy without duplicating logic
- **Fast failure for permanent errors** -- three-layer non-retryable detection prevents wasting time on errors that cannot self-heal
- **Circuit breaker prevents cascading failures** -- the LLM retry layer stops hammering a rate-limited API, which would only extend the lockout
- **Callback extensibility** -- `onRetry` enables logging, metrics, and state tracking without modifying retry internals
- **Two utilities, clear scope** -- `withRetry` for general use, `retryWithBackoff` for LLM-specific rate limit handling

## Related Patterns

- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
