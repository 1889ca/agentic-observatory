# Error Triage and Recovery

> Categorize failures into protocol, transient, and runtime classes with distinct recovery strategies for each.

## Problem

Not all errors are equal. A malformed API request (protocol error) can't be fixed by retrying. A network timeout (transient error) usually resolves on its own. A null reference in business logic (runtime error) needs investigation. Treating all errors the same — either retrying everything or failing on everything — wastes resources and frustrates users.

## Context

- An orchestrator executing tool calls, API requests, and database operations
- Errors originate from multiple layers: network, external APIs, internal logic, LLM responses
- Some operations are idempotent (safe to retry), others are not
- User experience depends on quick recovery from recoverable failures
- Audit trail needed for post-mortem analysis

## Solution

### Three Error Categories

Every caught error is classified before any recovery attempt:

**Protocol Errors** — The request itself is invalid. Wrong parameters, missing required fields, unsupported operations. These are bugs, not temporary conditions. Recovery: fail immediately, log for developer review.

**Transient Errors** — The infrastructure is temporarily unavailable. Network timeouts, rate limits, service restarts, database connection pool exhaustion. Recovery: retry with exponential backoff.

**Runtime Errors** — The logic hit an unexpected state. Null references, type mismatches, assertion failures in business logic. Recovery: attempt an alternative approach, then fail gracefully if the alternative also fails.

```javascript
function triageError(err) {
  // Protocol: bad input, invalid schema, unknown tool
  if (err.code === 'INVALID_PARAMS' || err.status === 400) return 'protocol';
  if (err.code === 'UNKNOWN_TOOL') return 'protocol';

  // Transient: network, rate limit, temporary unavailability
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return 'transient';
  if (err.status === 429 || err.status === 503) return 'transient';

  // Everything else is runtime
  return 'runtime';
}
```

### Recovery Strategies

Each category triggers a different recovery path:

```javascript
async function executeWithRecovery(tool, params) {
  try {
    return await tool.execute(params);
  } catch (err) {
    const category = triageError(err);

    switch (category) {
      case 'protocol':
        // Unrecoverable — log and surface to caller
        log.error(`Protocol error in ${tool.name}:`, err);
        throw err;

      case 'transient':
        // Retry with backoff: 1s, 2s, 4s
        return await retryWithBackoff(tool, params, {
          maxRetries: 3,
          baseDelay: 1000
        });

      case 'runtime':
        // Try recovery: alternative params, fallback tool, or graceful degradation
        const recovery = getRecoveryStrategy(tool, err);
        if (recovery) return await recovery.execute(params);
        throw err;
    }
  }
}
```

### Model Fallback

A specific case of transient recovery: when the primary LLM (Claude) is unavailable, the system falls back to an alternative (Gemini):

```javascript
async function dispatchToModel(context) {
  try {
    return await claude.generate(context);
  } catch (err) {
    if (triageError(err) === 'transient') {
      log.warn('Claude unavailable, falling back to Gemini');
      return await gemini.generate(context);
    }
    throw err;
  }
}
```

### Worker Dispatch Fallback

Similarly, when no local workers are available for a satellite job, the system falls back to GitHub-hosted Claude Code actions:

```javascript
async function dispatchTask(task) {
  const worker = findAvailableWorker(task.requiredCapabilities);
  if (worker) return await assignToWorker(worker, task);

  // No local workers — fall back to GitHub CC action
  log.info(`No workers for task ${task.id}, dispatching to GitHub`);
  return await dispatchToGitHubAction(task);
}
```

### Fire-and-Forget Stats

Error statistics are recorded asynchronously so that error handling never adds latency to the response path:

```javascript
// Non-blocking — errors in recording don't affect the operation
recordErrorStats(tool.name, category, err).catch(() => {});
```

## Implications

- Triage classification adds a decision point to every error path — must be fast
- Retry on transient errors can mask persistent failures if the retry count is too high
- Runtime recovery strategies must be registered per-tool — adds maintenance burden
- Model fallback changes response quality (Gemini vs. Claude) — users may notice
- Fire-and-forget stats can lose data under high error rates
- Classification heuristics can miscategorize — a 503 from an overloaded service looks transient but may be permanent

## Code Example

```javascript
// Retry with exponential backoff
async function retryWithBackoff(tool, params, { maxRetries = 3, baseDelay = 1000 }) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await tool.execute(params);
    } catch (err) {
      lastError = err;
      if (triageError(err) !== 'transient') throw err; // Don't retry non-transient
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Gateway-Brain Split](./gateway-brain-split.md)
