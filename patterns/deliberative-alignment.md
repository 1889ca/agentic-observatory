# Deliberative Alignment

> Standalone multi-model voting module invoked explicitly for high-stakes decisions, dispatching to multiple agents for EXECUTE/QUEUE consensus.

## Problem

An autonomous agent sometimes faces decisions where a single model's judgment is unreliable. Defaulting to queue wastes human attention on actions the agent could handle. Defaulting to execute risks overstepping. The system needs a tiebreaker that's better than a coin flip but cheaper than a human — and it should be invokable on demand, not tied to a specific scoring threshold.

## Context

- Multiple AI models available as voting agents
- High-stakes or ambiguous decisions where single-model judgment is insufficient
- A need to reduce false escalations without increasing unauthorized actions
- Privacy constraints — tool arguments may contain PII or secrets
- Deliberation is a standalone module, not embedded in the autonomy scoring pipeline

## Solution

### Standalone Module

Deliberative alignment is a standalone module that can be invoked explicitly by any part of the system that needs multi-model consensus. It is not automatically triggered by confidence scores or integrated into the autonomy band system:

```javascript
// Deliberation is called explicitly, not triggered by thresholds
const result = await deliberate(toolName, context, options);
// Returns: { decision: 'EXECUTE' | 'QUEUE', votes, mode }
```

### Multi-Model Vote Dispatch

When invoked, the system dispatches the decision context to multiple available agents. Each agent is asked a simple binary question: EXECUTE or QUEUE?

```javascript
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MIN_AGENTS = 2;

async function deliberate(toolName, context, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minAgents = DEFAULT_MIN_AGENTS,
    requireUnanimous = false,
  } = options;

  // Never log raw tool args — may contain PII/secrets
  const sanitizedContext = {
    tool: toolName,
    description: context.description,
  };

  const agents = getAvailableAgents();

  if (agents.length < minAgents) {
    return { decision: 'QUEUE', reason: 'insufficient_agents' };
  }

  const prompt = buildVotePrompt(sanitizedContext);
  const votes = await collectVotes(agents, prompt, timeoutMs);

  return tallyVotes(votes, { requireUnanimous });
}
```

### Vote Collection and Parsing

Each agent's response is parsed for a structured DECISION line. Agents that time out or error are counted as QUEUE votes (safe default):

```javascript
async function collectVotes(agents, prompt, timeoutMs) {
  const results = await Promise.allSettled(
    agents.map(agent =>
      Promise.race([
        agent.ask(prompt),
        timeout(timeoutMs),
      ])
    )
  );

  return results.map((result, i) => {
    if (result.status === 'rejected') {
      return { agent: agents[i].id, vote: 'QUEUE', reason: 'timeout_or_error' };
    }
    return parseVote(agents[i].id, result.value);
  });
}

function parseVote(agentId, response) {
  const match = response.match(/DECISION:\s*(EXECUTE|QUEUE|ESCALATE)/i);

  if (!match) {
    return { agent: agentId, vote: 'QUEUE', reason: 'unparseable' };
  }

  const raw = match[1].toUpperCase();
  const vote = raw === 'ESCALATE' ? 'QUEUE' : raw;

  return { agent: agentId, vote, reason: raw === 'ESCALATE' ? 'escalate_as_queue' : 'explicit' };
}
```

### Vote Tallying

Two modes: unanimous (all must agree to execute) and majority (ties default to queue):

```javascript
function tallyVotes(votes, { requireUnanimous = false }) {
  const executeCount = votes.filter(v => v.vote === 'EXECUTE').length;
  const queueCount = votes.filter(v => v.vote === 'QUEUE').length;

  if (requireUnanimous) {
    const decision = queueCount === 0 ? 'EXECUTE' : 'QUEUE';
    return { decision, votes, mode: 'unanimous' };
  }

  if (executeCount > queueCount) {
    return { decision: 'EXECUTE', votes, mode: 'majority' };
  }

  return { decision: 'QUEUE', votes, mode: 'majority' };
}
```

### Configuration

Controlled via environment variables with sensible defaults:

```javascript
const config = {
  enabled: process.env.RILEY_DELIBERATIVE_ALIGNMENT_ENABLED === 'true',
  timeoutMs: parseInt(process.env.RILEY_DELIBERATIVE_ALIGNMENT_TIMEOUT_MS) || 45000,
  minAgents: parseInt(process.env.RILEY_DELIBERATIVE_ALIGNMENT_MIN_AGENTS) || 2,
  requireUnanimous: process.env.RILEY_DELIBERATIVE_ALIGNMENT_REQUIRE_UNANIMOUS === 'true',
  models: process.env.RILEY_DELIBERATIVE_ALIGNMENT_MODELS?.split(',') || [],
};
```

## Implications

- Adds 0-45 seconds of latency per deliberation call — callers must decide when the cost is justified
- Requires at least 2 available agents; if the model pool shrinks below minimum, all deliberations default to queue
- ESCALATE votes from agents are treated as QUEUE — the system does not have a separate escalation path from deliberation
- Never logging raw tool arguments is a hard privacy constraint that limits the quality of agent voting context
- Unanimous mode is safer but produces more false queues; majority mode is faster but risks a single model's bad judgment tipping the balance
- As a standalone module, deliberation can be invoked from any context — not just autonomy gating
- Ties defaulting to QUEUE means the system is biased toward caution, which is appropriate for autonomy decisions

## Code Example

```javascript
// Explicit invocation from any system component
async function handleHighStakesDecision(toolName, context) {
  if (!config.enabled) {
    // Deliberation disabled — fall back to queue
    return { action: 'queue', reason: 'deliberation_disabled' };
  }

  const result = await deliberate(toolName, context, config);

  if (result.decision === 'EXECUTE') {
    return { action: 'execute', deliberation: result };
  }

  return { action: 'queue', deliberation: result };
}
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
- [Worker Permission Escalation](./satellite-permission-escalation.md)
