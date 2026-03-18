# Error Triage and Recovery

> Dual-layer error handling where build/test failures are auto-retryable (agents can fix the code) and network/permission errors are not (agents cannot fix infrastructure).

## Problem

Not all errors are equal, and the common intuition about which errors to retry is backwards for AI agents. Traditional systems retry transient network errors and give up on code failures. But an AI agent can fix a syntax error and retry the build — it cannot fix a refused connection or a revoked API key. Treating all errors the same leads to wasted retries on unfixable problems and missed recovery opportunities on fixable ones.

## Context

- An AI agent executing build, test, lint, and deploy operations
- Errors originating from multiple layers: build tooling, test runners, network, file system, authentication
- The agent can modify code between retry attempts (unlike a traditional retry loop)
- Some errors signal problems the agent can address (broken code), others signal problems it cannot (infrastructure, permissions)
- A learning system that benefits from categorizing errors for pattern extraction

## Solution

### Layer 1: Retryability Classification

The key insight: auto-retry patterns target build and test failures — errors where the agent can fix the underlying code and try again. Network and permission errors are non-retryable because no amount of code changes will fix them.

```javascript
// error-classifier.js

// RETRYABLE: Agent can fix the code and retry
const AUTO_RETRY_PATTERNS = {
  file_too_long: [/husky.*max-lines/, /exceeds.*line.?limit/],
  eslint_error: [/eslint.*error/, /linting\s+failed/],
  typescript_error: [/tsc.*error/, /typescript.*error/],
  test_failure: [/test.*failed/, /jest.*fail/, /\d+\s+failing/],
  import_error: [/cannot\s+find\s+module/, /import.*not\s+found/],
  merge_conflict: [/conflict/, /<{7}/],
  syntax_error: [/syntaxerror/, /unexpected\s+token/],
  build_failure: [/build\s+failed/, /compilation\s+failed/],
  pre_commit_hook: [/husky.*pre-commit/, /hook.*failed/],
};

// NON-RETRYABLE: Agent cannot fix these — infrastructure/permission problems
const NON_RETRYABLE_PATTERNS = [
  /EACCES/i,
  /ENOENT.*no such file/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /authentication\s+failed/i,
  /permission\s+denied/i,
  /access\s+denied/i,
  /rate\s+limit/i,
  /quota\s+exceeded/i,
  /invalid\s+api\s+key/i,
  /please\s+run\s+\/login/i,
];

function classify(error) {
  const message = error.message || String(error);

  // Check non-retryable first — these are hard stops
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { isRetryable: false, errorType: 'non_retryable' };
    }
  }

  // Check auto-retry patterns — agent can fix and retry
  for (const [category, patterns] of Object.entries(AUTO_RETRY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        return { isRetryable: true, errorType: category };
      }
    }
  }

  // Unknown errors default to non-retryable (safe default)
  return { isRetryable: false, errorType: 'unknown' };
}
```

### Layer 2: Three-Category Learning Triage

The second layer classifies errors into three categories for the learning system. This is separate from retryability — it determines what the system can learn from each error:

```javascript
// learning/error-triage.js
const ERROR_CATEGORIES = {
  PROTOCOL: 'protocol',    // LLM misused a tool (missing params, invalid types, unknown actions, format failures)
  RUNTIME: 'runtime',      // Code bugs (TypeError, ReferenceError, DB errors, ENOENT, EACCES, module not found)
  TRANSIENT: 'transient',  // Network/temporary (ECONNRESET, ECONNREFUSED, ETIMEDOUT, socket hang up, 429, 502/503/504)
};

function triage(error, toolName, args) {
  const message = error.message || String(error);

  // Protocol: LLM called a tool incorrectly
  if (isProtocolError(error)) {
    return {
      category: ERROR_CATEGORIES.PROTOCOL,
      toolName,
      subtype: detectProtocolSubtype(error, args),
      learnable: true,  // Feed to anti-pattern system
    };
  }

  // Transient: network and temporary infrastructure issues
  if (isTransientError(message)) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT,
      learnable: false,  // Nothing to learn — just bad luck
    };
  }

  // Runtime: code bugs and unexpected state
  return {
    category: ERROR_CATEGORIES.RUNTIME,
    learnable: false,
  };
}
```

### Recovery Strategies

The two layers combine to drive different recovery paths:

```javascript
async function executeWithRecovery(tool, params) {
  try {
    return await tool.execute(params);
  } catch (err) {
    const classification = classify(err);
    const triageResult = triage(err, tool.name, params);

    if (classification.isRetryable) {
      // Build/test failure — agent can fix the code and retry
      return {
        error: err.message,
        retryable: true,
        errorType: classification.errorType,
        _retryHint: generateFixHint(classification.errorType, err),
      };
    }

    if (triageResult.category === 'protocol' && triageResult.learnable) {
      // Protocol error — feed to anti-pattern learning
      await antiPatterns.recordProtocolError(err, triageResult);
      return {
        error: err.message,
        retryable: false,
        _retryHint: generateRecoveryHint(tool.name, params, err),
      };
    }

    // Non-retryable (network, permissions, etc.) — fail with context
    throw err;
  }
}
```

### Fire-and-Forget Stats

Error statistics are recorded asynchronously so error handling never adds latency:

```javascript
// Non-blocking — errors in recording don't affect the operation
recordErrorStats(tool.name, triageResult).catch(() => {});
```

## Implications

- The inverted retry logic (retry code failures, not network failures) only makes sense for AI agents that can modify code between attempts — traditional services should use traditional retry patterns
- Auto-retry patterns are broad regex matches that can miscategorize novel errors — the unknown-defaults-to-non-retryable policy is deliberately conservative
- Protocol errors feeding into anti-pattern learning creates a self-improving loop: recurring tool misuse gets injected into the system prompt to prevent recurrence
- ECONNREFUSED and ETIMEDOUT being non-retryable means the system fails fast on infrastructure problems rather than burning agent time on hopeless retries
- The three-category triage (protocol/runtime/transient) is orthogonal to retryability — a runtime error like a missing module is retryable (agent can install it) but not a learning opportunity
- Rate limit errors are non-retryable from the agent's perspective because the agent cannot reduce its own rate — the backoff queue handles rate limiting at a different layer

## Code Example

```javascript
// Build failure recovery — the primary auto-retry use case
async function buildWithRecovery(project, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await runBuild(project);

    if (result.success) return result;

    const classification = classify(result.error);

    if (!classification.isRetryable) {
      // Network error, permission issue — stop immediately
      throw new Error(`Non-retryable build error: ${result.error.message}`);
    }

    // Build/lint/test failure — agent can fix the code
    const fix = await generateFix(classification.errorType, result.error);
    await applyFix(fix);
    // Loop continues with next attempt
  }

  throw new Error(`Build failed after ${maxAttempts} attempts`);
}
```

## Related Patterns

- [Anti-Pattern Learning Loop](./anti-pattern-learning-loop.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
