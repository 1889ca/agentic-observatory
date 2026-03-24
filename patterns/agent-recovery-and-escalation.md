# Agent Recovery and Escalation

> Classify failures as retryable or non-retryable, apply exponential backoff for transient errors, and route permanent failures through an approval flow tied to the autonomy tier system.

## Problem

Agents fail. Tools time out, APIs return errors, permissions get revoked, and resources go missing. A naive agent either crashes on the first failure or retries blindly until it hits a rate limit. Permanent failures are a different problem entirely — the agent needs to surface them to the user without losing track of what it was doing. Without a clear split between "try again" and "ask a human," agents become either fragile or they silently swallow errors that needed attention.

## Context

- An agent executing multi-step plans with heterogeneous tool calls
- Failures that range from transient (network timeout, rate limit) to permanent (missing permission, resource not found)
- A user who may not be immediately available, but who must be consulted for non-retryable failures
- An autonomy tier system (AUTO / NOTIFY / ASK) that governs whether actions proceed silently, are reported, or require explicit approval
- An approval flow module that handles the mechanics of presenting decisions to the user and recording responses

## Solution

### Failure Classification

Every tool failure is classified into one of two categories, which determines the recovery path:

```javascript
// illustrative — actual classification lives in the tool execution wrapper
function classifyFailure(error) {
  // Retryable: transient infrastructure errors
  if (
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.status === 429 ||
    error.status === 503
  ) {
    return { retryable: true };
  }

  // Non-retryable: permanent errors that require human input
  if (error.status === 401 || error.status === 403) {
    return { retryable: false, reason: 'permission', message: error.message };
  }

  if (error.status === 404) {
    return { retryable: false, reason: 'not_found', message: error.message };
  }

  // Default: treat unknown errors as non-retryable to avoid blind looping
  return { retryable: false, reason: 'unknown', message: error.message };
}
```

### Retryable Errors: Exponential Backoff

Transient failures are retried with exponential backoff and a hard ceiling on attempts. If all retries are exhausted, the failure is re-classified as non-retryable and routed to the approval flow.

```javascript
// illustrative — retry logic wraps individual tool calls
async function retryWithBackoff(toolCall, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    await sleep(delay);

    try {
      return await executeTool(toolCall.tool, toolCall.params);
    } catch (error) {
      const classification = classifyFailure(error);

      if (!classification.retryable || attempt === maxAttempts) {
        // Escalate after exhausting retries
        return escalateToApprovalFlow({
          tool: toolCall.tool,
          params: toolCall.params,
          reason: classification.reason || 'retry_exhausted',
          message: `Failed after ${attempt} attempt(s): ${error.message}`
        });
      }
    }
  }
}
```

### Non-Retryable Errors: Approval Flow Escalation

`approval-flow.js` handles the user-facing side of escalation. It receives a failure record, checks the current autonomy tier, and either notifies the user or blocks until they respond.

```javascript
// illustrative — approval-flow.js integration
async function escalateToApprovalFlow({ tool, params, reason, message }) {
  const tier = await getAutonomyTier();  // AUTO | NOTIFY | ASK

  const escalation = {
    id: crypto.randomUUID(),
    tool,
    params,
    reason,
    message,
    timestamp: Date.now()
  };

  if (tier === 'AUTO') {
    // AUTO tier: log the failure and abort the action without user interruption
    await logEscalation(escalation);
    return { status: 'aborted', reason };
  }

  if (tier === 'NOTIFY') {
    // NOTIFY tier: inform the user but do not block for a response
    await notifyUser({ type: 'failure', ...escalation });
    return { status: 'aborted', reason };
  }

  // ASK tier: block until the user responds
  await notifyUser({ type: 'approval_required', ...escalation });
  const response = await waitForApproval(escalation.id);

  return response.approved
    ? await executeTool(tool, { ...params, ...response.overrides })
    : { status: 'rejected', reason };
}
```

### Clarification Requests

When the agent encounters ambiguity rather than an error — for example, an instruction that references a resource that could match multiple things — it asks the user a direct question through the same approval flow channel. There is no candidate-selection UI; the question is freeform and the user responds in plain text.

```javascript
// illustrative — clarification goes through the same approval flow channel
async function requestClarification({ question, context }) {
  const id = crypto.randomUUID();

  await notifyUser({
    type: 'clarification_needed',
    id,
    question,
    context
  });

  const response = await waitForApproval(id);
  return response.answer;  // plain text from user
}
```

### Autonomy Tier Integration

The approval flow checks the current tier at escalation time rather than at planning time, so a tier change mid-run takes effect immediately. The tier governs three behaviors:

| Tier | Retryable failure | Non-retryable failure | Clarification request |
|------|-------------------|-----------------------|-----------------------|
| AUTO | Retry, then abort silently | Abort and log | Ask (unavoidable) |
| NOTIFY | Retry, then abort with notification | Abort with notification | Ask |
| ASK | Retry, then escalate for approval | Escalate for approval | Ask |

Approvals are handled individually as they arise. There is no batching or queuing — each escalation produces one notification and waits for one response.

## Implications

- Retry ceilings must be hard — unbounded retries amplify cascading failures and can exhaust downstream rate limits
- Defaulting unknown errors to non-retryable is conservative but correct; retrying an unknown error risks repeating a destructive operation
- The AUTO tier suppresses escalation noise at the cost of visibility; operators should review escalation logs regularly
- Clarification responses are unstructured text, so the agent must be able to interpret partial or ambiguous answers gracefully
- The approval flow is a synchronous blocker in ASK mode; long user response times stall the agent's task queue

## Code Example

```javascript
// illustrative — safe tool execution with recovery
async function safeExecute(toolCall) {
  try {
    return await executeTool(toolCall.tool, toolCall.params);
  } catch (error) {
    const classification = classifyFailure(error);

    if (classification.retryable) {
      return await retryWithBackoff(toolCall);
    }

    return await escalateToApprovalFlow({
      tool: toolCall.tool,
      params: toolCall.params,
      reason: classification.reason,
      message: classification.message
    });
  }
}
```

## Related Patterns

- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
