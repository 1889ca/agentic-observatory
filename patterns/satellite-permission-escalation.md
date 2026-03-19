# Worker Permission Escalation

> Multi-model voting mechanism for escalating worker actions that fall in the borderline autonomy band, using deliberative alignment for EXECUTE/QUEUE consensus.

## Problem

When a worker agent needs to perform an action that sits between "clearly allowed" and "clearly needs human approval," the system has no good default. Auto-executing risks overstepping. Auto-queuing wastes human attention. A single model's judgment on borderline cases is unreliable. The system needs a structured escalation path that resolves ambiguity without always punting to the user.

## Context

- Workers executing tool calls with varying levels of risk and reversibility
- A confidence scoring system that produces a numeric score for each action
- A "notify" band (0.60-0.85) where actions are neither clearly safe nor clearly dangerous
- Multiple AI models available to participate in voting
- The need for a safe default when the voting system itself fails (timeouts, insufficient agents)

## Solution

### Permission Escalation via Deliberative Alignment

Permission escalation is not a standalone module — it is integrated into the confidence-based autonomy system through deliberative alignment. When a tool decision's confidence score falls in the notify band, the system dispatches the decision to multiple agents for a vote:

```javascript
async function escalatePermission(toolName, context) {
  const confidence = context.confidence;

  // High confidence — no escalation needed
  if (confidence >= 0.85) {
    return { action: 'execute', method: 'auto' };
  }

  // Notify band — use multi-model voting
  if (confidence >= 0.60) {
    const result = await deliberate(toolName, context);

    if (result.decision === 'EXECUTE') {
      return { action: 'execute', method: 'deliberation', votes: result.votes };
    }

    // QUEUE decision — escalate to user approval
    return { action: 'queue', method: 'deliberation', votes: result.votes };
  }

  // Low confidence — queue directly, no vote needed
  return { action: 'queue', method: 'auto' };
}
```

### Vote Outcomes Map to Permission Decisions

The voting system produces one of two outcomes, each mapping directly to a permission decision:

```javascript
// Vote outcome: EXECUTE → proceed with tool execution
// Vote outcome: QUEUE → add to user approval queue

async function handleVoteOutcome(toolName, context, voteResult) {
  switch (voteResult.decision) {
    case 'EXECUTE':
      // Majority (or unanimous) agents agree: safe to proceed
      return await executeTool(toolName, context.args);

    case 'QUEUE':
      // Agents disagree or vote to queue: escalate to human
      return await addToApprovalQueue({
        tool: toolName,
        context: context.description,
        confidence: context.confidence,
        votes: voteResult.votes,
        reason: summarizeVoteReason(voteResult),
      });
  }
}
```

### Safe Defaults for Failure Cases

Every failure mode in the deliberation system defaults to QUEUE — the safe option:

```javascript
function getDefaultDecision(failureReason) {
  // All failure modes default to queue (safety)
  // - Insufficient agents available: QUEUE
  // - Agent timeout: counted as QUEUE vote
  // - Unparseable agent response: counted as QUEUE vote
  // - Error during deliberation: QUEUE (logged, doesn't break execution)
  // - Vote tie: QUEUE

  return {
    decision: 'QUEUE',
    reason: failureReason,
    fallback: true,
  };
}

async function deliberateWithFallback(toolName, context) {
  try {
    return await deliberate(toolName, context);
  } catch (err) {
    // Error during deliberation — log but don't break execution
    log.warn('Deliberation failed, defaulting to queue', {
      tool: toolName,
      error: err.message,
    });
    return getDefaultDecision('deliberation_error');
  }
}
```

### No Separate Permission Module

The permission escalation system does not exist as a standalone service. It is composed from existing patterns:

1. **Confidence scoring** determines the band (from confidence-based autonomy gating)
2. **Deliberative alignment** handles the voting for notify-band decisions
3. **Approval queue** receives decisions that need human review

```javascript
// The full escalation flow is three existing systems composed together
async function gateWorkerAction(toolName, args) {
  // Step 1: Score confidence (from autonomy gating)
  const confidence = await scoreConfidence(toolName, args);

  // Step 2: Route by band
  if (confidence >= 0.85) {
    return await executeTool(toolName, args);
  }

  if (confidence >= 0.60) {
    // Step 2a: Deliberative alignment votes
    const result = await deliberateWithFallback(toolName, {
      confidence,
      description: describeAction(toolName, args),
    });

    if (result.decision === 'EXECUTE') {
      return await executeTool(toolName, args);
    }
  }

  // Step 3: Queue for human approval
  return await addToApprovalQueue({ tool: toolName, confidence });
}
```

## Implications

- Permission escalation adds 0-45 seconds of latency for notify-band actions (the deliberation timeout) — fast actions may feel sluggish
- The system biases heavily toward safety: ties, timeouts, errors, and insufficient agents all result in QUEUE
- No way to grant elevated permissions mid-session — a queued action stays queued until a human reviews it
- The voting mechanism inherits all limitations of deliberative alignment (minimum agent count, timeout handling, privacy constraints on tool args)
- Composing escalation from existing patterns (confidence + deliberation + queue) avoids a standalone permission module but means changes to any component affect escalation behavior
- Workers never know they were voted on — the escalation is transparent from the worker's perspective

## Code Example

```javascript
// Practical integration: worker dispatch with permission gating
async function dispatchWorkerTask(task) {
  const tools = task.requiredTools || [];

  for (const tool of tools) {
    const confidence = await scoreConfidence(tool, task.args);

    if (confidence < 0.60) {
      // Below notify band — queue entire task
      return await addToApprovalQueue({
        task: task.id,
        tool,
        confidence,
        reason: 'Below notify band threshold',
      });
    }

    if (confidence < 0.85) {
      // In notify band — deliberate
      const result = await deliberateWithFallback(tool, {
        confidence,
        description: `Task ${task.id} requires ${tool}`,
      });

      if (result.decision === 'QUEUE') {
        return await addToApprovalQueue({
          task: task.id,
          tool,
          confidence,
          votes: result.votes,
        });
      }
    }
  }

  // All tools passed — execute the task
  return await executeTask(task);
}
```

## Relationship to the Autonomy Stack

Worker permission escalation is not a standalone module — it composes three existing patterns into an escalation flow for worker tool calls:

1. **[Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)** scores the action's confidence
2. **[Deliberative Alignment](./deliberative-alignment.md)** votes on notify-band decisions
3. **[Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)** routes the final decision

See each pattern for details on its specific layer. This pattern documents how they compose for the worker dispatch use case.

## Related Patterns

- [Deliberative Alignment](./deliberative-alignment.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
