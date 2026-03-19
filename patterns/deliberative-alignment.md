# Deliberative Alignment

> Multi-model voting system for borderline autonomy decisions, dispatching to multiple agents for EXECUTE/QUEUE consensus in the notify band.

## Problem

An autonomous agent with confidence-based autonomy gating has three clear zones: high confidence (auto-execute), low confidence (queue for human), and a messy middle. The "notify" band (0.60-0.85) is where the hardest decisions live — the agent is somewhat confident but not enough to act unilaterally. A single model's judgment in this band is unreliable. Defaulting to queue wastes human attention on actions the agent could handle. Defaulting to execute risks overstepping. The system needs a tiebreaker that's better than a coin flip but cheaper than a human.

## Context

- An agent with numeric confidence scoring for tool decisions
- Three decision bands: execute (>= 0.85), notify (0.60-0.85), queue (< 0.60)
- Multiple AI models available as voting agents
- Actions in the notify band that are neither clearly safe nor clearly dangerous
- A need to reduce false escalations without increasing unauthorized actions
- Privacy constraints — tool arguments may contain PII or secrets

## Solution

### Trigger Condition

Deliberative alignment only activates for decisions in the notify band. High-confidence and low-confidence decisions bypass it entirely:

```javascript
// Decision boundaries
const THRESHOLDS = {
  execute: 0.85,  // >= 0.85: auto-execute, no vote needed
  notify: 0.60,   // >= 0.60: trigger deliberative alignment
  queue: 0.40,    // >= 0.40: queue for review
  // < 0.40: queue immediately
};

function shouldDeliberate(confidence) {
  return confidence >= THRESHOLDS.notify && confidence < THRESHOLDS.execute;
}
```

### Multi-Model Vote Dispatch

When a tool decision lands in the notify band, the system dispatches the decision context to multiple available agents. Each agent is asked a simple binary question: EXECUTE or QUEUE?

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
    confidence: context.confidence,
  };

  const agents = getAvailableAgents();

  if (agents.length < minAgents) {
    // Insufficient agents — default to queue (safety)
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
      // Timeout or error — counted as QUEUE (safe default)
      return { agent: agents[i].id, vote: 'QUEUE', reason: 'timeout_or_error' };
    }

    return parseVote(agents[i].id, result.value);
  });
}

function parseVote(agentId, response) {
  // Look for DECISION: EXECUTE|QUEUE|ESCALATE
  const match = response.match(/DECISION:\s*(EXECUTE|QUEUE|ESCALATE)/i);

  if (!match) {
    return { agent: agentId, vote: 'QUEUE', reason: 'unparseable' };
  }

  const raw = match[1].toUpperCase();
  // ESCALATE is treated as QUEUE
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
    // All votes must be EXECUTE; any QUEUE = QUEUE
    const decision = queueCount === 0 ? 'EXECUTE' : 'QUEUE';
    return { decision, votes, mode: 'unanimous' };
  }

  // Majority vote — ties default to QUEUE
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

- Adds 0-45 seconds of latency to every notify-band decision — unacceptable for time-sensitive actions without a fast-path override
- Requires at least 2 available agents; if the model pool shrinks below minimum, all notify-band decisions default to queue
- ESCALATE votes from agents are treated as QUEUE — the system does not have a separate escalation path from deliberation
- Never logging raw tool arguments is a hard privacy constraint that limits the quality of agent voting context
- Unanimous mode is safer but produces more false queues; majority mode is faster but risks a single model's bad judgment tipping the balance
- The 0.60-0.85 band width is a design choice — too narrow and deliberation rarely triggers, too wide and it becomes a bottleneck
- Ties defaulting to QUEUE means the system is biased toward caution, which is appropriate for autonomy decisions

## Code Example

```javascript
// Integration with the autonomy gating system
async function gateToolExecution(toolName, context) {
  const confidence = context.confidence;

  if (confidence >= 0.85) {
    return { action: 'execute' };
  }

  if (confidence >= 0.60 && config.enabled) {
    const result = await deliberate(toolName, context, config);

    if (result.decision === 'EXECUTE') {
      return { action: 'execute', deliberation: result };
    }

    return { action: 'queue', deliberation: result };
  }

  return { action: 'queue' };
}
```

## Relationship to Other Autonomy Patterns

This pattern is the innermost layer of the three-layer autonomy system:

- **[Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)** — Static routing. Classifies decisions into tiers and controls notification delivery.
- **[Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)** — Dynamic trust. Tracks domain success/failure and provides the confidence score that determines which band a decision falls into.
- **Deliberative Alignment (this pattern)** — Tiebreaker. Only fires when confidence is in the notify band (0.60-0.85). Uses multi-model voting to resolve ambiguity without human intervention.

Deliberative alignment never activates outside the notify band — high-confidence and low-confidence decisions are handled by the outer layers.

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Multi-Model Deliberation](./multi-model-deliberation.md)
- [Worker Permission Escalation](./satellite-permission-escalation.md)
