# Agent Recovery and Escalation

> Strategy-based recovery from tool failures with clarification workflows, batch approval grouping, and action buffering.

## Problem

Agents fail. Tools time out, APIs return errors, file systems run out of space, and permissions get revoked. A naive agent either crashes on the first failure or retries blindly until it hits a rate limit. Meanwhile, some failures aren't errors at all — they're ambiguity. The user said "deploy the app" but there are three apps and two environments. The agent needs to ask, but asking for every small clarification fragments the user's attention. And when multiple actions need approval, presenting them one at a time is exhausting. Without structured recovery, escalation, and batching, autonomous agents become either fragile or annoying.

## Context

- An agent executing multi-step plans with heterogeneous tool calls
- Failures that range from transient (network timeout) to permanent (missing permission)
- Ambiguous instructions that require user clarification
- Multiple pending actions that individually require approval
- A user who is not always immediately available to respond
- A need to continue useful work even when some operations are blocked

## Solution

### Failure Classification

Every tool failure is classified to determine the appropriate recovery strategy:

```javascript
function classifyFailure(error, toolCall) {
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
    return { type: 'transient', strategy: 'retry', maxAttempts: 3, backoff: 'exponential' };
  }

  if (error.status === 401 || error.status === 403) {
    return { type: 'permission', strategy: 'escalate', message: `Missing permission for ${toolCall.tool}` };
  }

  if (error.status === 404) {
    return { type: 'not_found', strategy: 'clarify', question: `Resource not found: ${toolCall.params.target}. Did you mean one of these?` };
  }

  if (error.status === 429) {
    const retryAfter = parseInt(error.headers?.['retry-after'] || '60', 10);
    return { type: 'rate_limit', strategy: 'buffer', delayMs: retryAfter * 1000 };
  }

  if (error.message?.includes('ambiguous')) {
    return { type: 'ambiguous', strategy: 'clarify' };
  }

  return { type: 'unknown', strategy: 'decompose', fallback: 'escalate' };
}
```

### Strategy Execution

Each strategy has a dedicated handler:

```javascript
const recoveryStrategies = {
  async retry(toolCall, classification) {
    for (let attempt = 1; attempt <= classification.maxAttempts; attempt++) {
      const delay = classification.backoff === 'exponential'
        ? Math.min(1000 * Math.pow(2, attempt - 1), 30000)
        : 1000;

      await sleep(delay);

      try {
        return await executeTool(toolCall.tool, toolCall.params);
      } catch (error) {
        if (attempt === classification.maxAttempts) {
          return recoveryStrategies.escalate(toolCall, {
            message: `Failed after ${attempt} retries: ${error.message}`
          });
        }
      }
    }
  },

  async decompose(toolCall, classification) {
    // Break the failing operation into smaller steps
    const subtasks = await llm.complete({
      system: `The tool call failed. Break this operation into smaller,
        more specific steps that might succeed individually.`,
      messages: [{
        role: 'user',
        content: JSON.stringify({ tool: toolCall.tool, params: toolCall.params, error: classification.type })
      }],
      response_format: { type: 'json_object' }
    });

    const results = [];
    for (const subtask of subtasks.steps) {
      try {
        results.push(await executeTool(subtask.tool, subtask.params));
      } catch (subError) {
        results.push({ error: subError.message, step: subtask });
      }
    }
    return results;
  },

  async escalate(toolCall, classification) {
    return escalationQueue.add({
      type: 'failure',
      tool: toolCall.tool,
      message: classification.message,
      context: toolCall,
      timestamp: Date.now()
    });
  }
};
```

### Clarification Workflows

When the agent encounters ambiguity, it constructs a targeted clarification request with options derived from context:

```javascript
async function requestClarification(toolCall, ambiguity) {
  // Gather candidate options from context
  const candidates = await findCandidates(toolCall, ambiguity);

  const clarification = {
    id: crypto.randomUUID(),
    question: ambiguity.question || `Which did you mean?`,
    options: candidates.map((c, i) => ({
      key: String(i + 1),
      label: c.name,
      description: c.summary,
      value: c
    })),
    allowFreeform: true,
    timeout: 5 * 60 * 1000,  // 5 minutes before auto-escalating
    pendingAction: toolCall
  };

  clarificationStore.set(clarification.id, clarification);

  await notifyUser({
    type: 'clarification_needed',
    id: clarification.id,
    question: clarification.question,
    options: clarification.options
  });

  return { status: 'awaiting_clarification', clarificationId: clarification.id };
}

async function handleClarificationResponse(clarificationId, response) {
  const clarification = clarificationStore.get(clarificationId);
  if (!clarification) throw new Error('Clarification expired');

  const selected = clarification.options.find(o => o.key === response.selection);
  const resolvedParams = {
    ...clarification.pendingAction.params,
    target: selected?.value || response.freeformInput
  };

  clarificationStore.delete(clarificationId);
  return await executeTool(clarification.pendingAction.tool, resolvedParams);
}
```

### Batch Approval Grouping

Instead of interrupting the user for each approval, the system groups pending approvals and presents them together:

```javascript
class ApprovalBatcher {
  constructor({ flushInterval = 30000, maxBatchSize = 10 }) {
    this.pending = [];
    this.flushInterval = flushInterval;
    this.maxBatchSize = maxBatchSize;
    this.timer = null;
  }

  add(action) {
    this.pending.push({
      id: crypto.randomUUID(),
      action,
      addedAt: Date.now()
    });

    if (this.pending.length >= this.maxBatchSize) {
      return this.flush();
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }

    return { status: 'queued', position: this.pending.length };
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;

    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0);
    const summary = batch.map(item => ({
      id: item.id,
      tool: item.action.tool,
      description: item.action.description,
      impact: item.action.impact
    }));

    const response = await notifyUser({
      type: 'batch_approval',
      actions: summary,
      message: `${batch.length} actions pending approval`
    });

    for (const item of batch) {
      const approved = response.approved?.includes(item.id);
      if (approved) {
        await executeTool(item.action.tool, item.action.params);
      }
    }
  }
}
```

### Action Buffer

Non-urgent actions are buffered and executed in scheduled windows to reduce noise and group related operations:

```javascript
class ActionBuffer {
  constructor() {
    this.buffers = new Map();  // category -> action[]
  }

  add(action, category = 'default') {
    if (!this.buffers.has(category)) {
      this.buffers.set(category, []);
    }
    this.buffers.get(category).push({
      action,
      bufferedAt: Date.now()
    });
  }

  async flushCategory(category) {
    const items = this.buffers.get(category) || [];
    this.buffers.set(category, []);

    // Deduplicate and merge where possible
    const merged = mergeActions(items.map(i => i.action));

    const results = [];
    for (const action of merged) {
      try {
        results.push(await executeTool(action.tool, action.params));
      } catch (error) {
        const classification = classifyFailure(error, action);
        results.push(await recoveryStrategies[classification.strategy](action, classification));
      }
    }

    return results;
  }
}
```

## Implications

- Retry strategies must have hard ceilings — unbounded retries can amplify cascading failures
- Decomposition via LLM is non-deterministic; the subtasks may not actually solve the original problem
- Clarification timeouts mean the agent must have a fallback when the user doesn't respond
- Batch approval reduces interruptions but adds latency — urgent actions should bypass the batcher
- Action buffering risks stale data; a buffered write based on a stale read may corrupt state
- The classification function is a critical single point of failure — misclassification leads to wrong recovery

## Code Example

```javascript
// Integration: wrap every tool call with recovery
async function safeExecute(toolCall) {
  try {
    return await executeTool(toolCall.tool, toolCall.params);
  } catch (error) {
    const classification = classifyFailure(error, toolCall);
    const strategy = recoveryStrategies[classification.strategy];

    if (!strategy) {
      return recoveryStrategies.escalate(toolCall, {
        message: `No recovery strategy for failure type: ${classification.type}`
      });
    }

    return await strategy(toolCall, classification);
  }
}
```

## Related Patterns

- [Error Triage and Recovery](./error-triage-and-recovery.md)
- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
