# Error Triage and Recovery

> Dual-layer error handling combining pattern-based retryability classification with three-category learning triage for distinct recovery strategies.

## Problem

Not all errors are equal. A malformed API request can't be fixed by retrying. A network timeout usually resolves on its own. An LLM misusing a tool is a learning opportunity. Treating all errors the same — either retrying everything or failing on everything — wastes resources and misses chances to improve.

## Context

- An orchestrator executing tool calls, API requests, and database operations
- Errors originate from multiple layers: network, external APIs, internal logic, LLM responses
- Some operations are idempotent (safe to retry), others are not
- User experience depends on quick recovery from recoverable failures
- Error patterns that recur should feed back into the system's learned behaviors

## Solution

### Layer 1: Pattern-Based Retryability

The first layer uses pattern arrays for fast binary classification — is this error retryable or not?

```javascript
// error-classifier.js
const AUTO_RETRY_PATTERNS = [
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /socket hang up/,
  /rate limit/i,
  /503 Service/,
  /429 Too Many/,
  /RESOURCE_EXHAUSTED/,
  /overloaded/i,
];

const NON_RETRYABLE_PATTERNS = [
  /INVALID_ARGUMENT/,
  /PERMISSION_DENIED/,
  /NOT_FOUND/,
  /ALREADY_EXISTS/,
  /FAILED_PRECONDITION/,
  /UNAUTHENTICATED/,
  /invalid.*schema/i,
];

function classify(error) {
  const message = error.message || String(error);

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { isRetryable: false, errorType: 'non_retryable' };
    }
  }

  for (const pattern of AUTO_RETRY_PATTERNS) {
    if (pattern.test(message)) {
      return { isRetryable: true, errorType: 'transient' };
    }
  }

  // Unknown errors default to non-retryable (safe default)
  return { isRetryable: false, errorType: 'unknown' };
}
```

### Layer 2: Three-Category Learning Triage

The second layer provides deeper classification for the learning system, distinguishing errors that represent improvement opportunities:

```javascript
// learning/error-triage.js
const ERROR_CATEGORIES = {
  PROTOCOL: 'protocol',    // LLM misused a tool — learning opportunity
  RUNTIME: 'runtime',      // Code bug or unexpected state
  TRANSIENT: 'transient',  // Network/temporary — retry
  UNKNOWN: 'unknown',
};

function triage(error, toolName, args) {
  // Protocol: LLM called a tool wrong (hallucinated params, wrong tool for task)
  if (error.code === 'INVALID_PARAMS' || error.message?.includes('not a function')) {
    return {
      category: ERROR_CATEGORIES.PROTOCOL,
      toolName,
      subtype: detectProtocolSubtype(error, args),
      learnable: true,  // Feed to anti-pattern system
    };
  }

  // Transient: infrastructure issues
  if (classify(error).isRetryable) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT,
      learnable: false,
    };
  }

  // Runtime: everything else
  return {
    category: ERROR_CATEGORIES.RUNTIME,
    learnable: false,
  };
}
```

### Recovery Strategies Per Category

Each category triggers a different recovery path:

```javascript
async function executeWithRecovery(tool, params) {
  try {
    return await tool.execute(params);
  } catch (err) {
    const { isRetryable } = classify(err);
    const triageResult = triage(err, tool.name, params);

    if (isRetryable) {
      // Transient: retry with exponential backoff
      return await retryWithBackoff(tool, params, {
        maxRetries: 3,
        baseDelay: 1000,
      });
    }

    if (triageResult.category === 'protocol' && triageResult.learnable) {
      // Protocol: feed to anti-pattern learning system
      await antiPatterns.recordProtocolError(err, triageResult);
      // Generate recovery hint for LLM self-correction
      return { error: err.message, _retryHint: generateRecoveryHint(tool.name, params, err) };
    }

    // Runtime or unknown: fail with context
    throw err;
  }
}
```

### Model Fallback Chain

A specific recovery strategy for LLM provider failures:

```javascript
async function dispatchToModel(context) {
  try {
    return await claude.generate(context);
  } catch (err) {
    if (classify(err).isRetryable) {
      try {
        return await gemini.generate(context);
      } catch (geminiErr) {
        return await openai.generate(context); // Final fallback
      }
    }
    throw err;
  }
}
```

### Fire-and-Forget Stats

Error statistics are recorded asynchronously so that error handling never adds latency:

```javascript
// Non-blocking — errors in recording don't affect the operation
recordErrorStats(tool.name, triageResult).catch(() => {});
```

## Implications

- The two-layer system separates concerns: Layer 1 is fast and operational (should I retry?), Layer 2 is analytical (can I learn from this?)
- Pattern arrays are fast to evaluate but can miscategorize novel errors — the unknown-defaults-to-non-retryable policy is deliberately conservative
- Protocol errors feeding into anti-pattern learning creates a self-improving error loop: recurring tool misuse gets automatically corrected
- Recovery hints give the LLM a chance to self-correct within the same conversation, reducing the need for user intervention
- The model fallback chain changes response quality (Claude → Gemini → OpenAI) — users may notice quality differences
- Fire-and-forget stats can lose data under high error rates, but this is acceptable since the learning system operates on aggregates

## Code Example

```javascript
// Retry with exponential backoff
async function retryWithBackoff(tool, params, { maxRetries = 3, baseDelay = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await tool.execute(params);
    } catch (err) {
      lastError = err;
      if (!classify(err).isRetryable) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}
```

## Related Patterns

- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
