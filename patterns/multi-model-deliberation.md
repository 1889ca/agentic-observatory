# Multi-Model Deliberation

> Round-robin multi-AI deliberation where Claude, Gemini, and Codex take turns responding to a shared transcript, building iteratively toward consensus over configurable rounds.

## Problem

Single-model responses have blind spots. A model may be confidently wrong, biased toward its training distribution, or miss perspectives that another architecture would catch. For high-stakes decisions -- architecture choices, debugging complex issues, evaluating competing approaches -- you want multiple opinions structured as a conversation, not just three independent answers.

## Context

- An orchestrator that can dispatch to multiple AI model APIs (Claude, Gemini, Codex)
- Decisions where collective reasoning matters more than speed
- Topics where different models have different strengths (reasoning, code, research, creativity)
- Need for structured output (consensus summary, per-agent positions) rather than raw chat

## Solution

### Riley's Implementation: Round-Robin Only

Riley implements a single deliberation mode: round-robin. The standalone Hivemind CLI tool (a separate project) supports additional modes (research, fibonacci, moderator, team), but within Riley's codebase, only round-robin is operational. The moderator mode exists as a TODO that falls back to round-robin:

```javascript
// lib/deliberation/index.js
async function runDeliberation({ topic, mode = 'round-robin', rounds = 3, models, systemPrompt, onTurn }) {
  let agents;
  if (models?.length > 0) {
    agents = await getAgentsByName(models);
  } else {
    agents = await getAvailableAgents();
  }

  if (agents.length === 0) {
    throw new Error('No AI agents available. Install at least one of: claude, gemini, codex');
  }

  let transcript;
  if (mode === 'moderator') {
    // TODO: Implement moderator mode — falls back to round-robin
    transcript = await runRoundRobin({ topic, agents, rounds, systemPrompt, onTurn });
  } else {
    transcript = await runRoundRobin({ topic, agents, rounds, systemPrompt, onTurn });
  }

  const consensus = extractConsensus(transcript);
  const markdown = formatTranscriptAsMarkdown(transcript, topic);

  return { consensus, transcript, markdown, agents: agents.map(a => a.name), rounds, mode };
}
```

### Agent Architecture

Each AI model is implemented as a subclass of `BaseAgent` with `isAvailable()` and `think()` methods:

```javascript
// lib/deliberation/agents/base.js
class BaseAgent {
  constructor(name, color) {
    this.name = name;
    this.color = color;
  }

  async isAvailable() { throw new Error('Not implemented'); }

  async think(conversationContext, systemPrompt) {
    throw new Error('Not implemented');
    // Returns: { response: string, metadata: object }
  }

  buildPrompt(conversationContext, systemPrompt) {
    return `${systemPrompt}

## Conversation So Far

${conversationContext}

---

Your turn. Read what the others have said, build on their ideas, push back where you disagree,
and add something novel. Be concise but substantive.`;
  }
}
```

Three implementations exist: Claude (via Anthropic API), Gemini (via Google AI), and Codex (via OpenAI). Agent availability is checked dynamically -- if a model's API key is not configured, it is skipped.

### Round-Robin Execution

Each round iterates through all available agents. Each agent sees the full transcript so far and adds its contribution:

```javascript
async function runRoundRobin({ topic, agents, rounds = 3, systemPrompt, onTurn }) {
  const prompt = systemPrompt || buildSystemPrompt(topic);
  const transcript = [];

  transcript.push({
    role: 'system',
    content: `# Deliberation: ${topic}\n\n${prompt}`,
    timestamp: new Date().toISOString(),
  });

  for (let round = 1; round <= rounds; round++) {
    for (const agent of agents) {
      if (onTurn) onTurn({ round, agent: agent.name, status: 'thinking' });

      try {
        const context = transcript
          .filter(t => t.role !== 'system')
          .map(t => `## ${t.agent} (${t.timestamp})\n\n${t.content}`)
          .join('\n\n---\n\n');

        const result = await agent.think(context || '(No conversation yet)', prompt);

        transcript.push({
          role: 'agent',
          agent: agent.name,
          content: result.response,
          timestamp: new Date().toISOString(),
          round,
        });
      } catch (err) {
        transcript.push({
          role: 'agent',
          agent: agent.name,
          content: `[Error: ${err.message}]`,
          timestamp: new Date().toISOString(),
          round,
          error: true,
        });
      }
    }
  }

  return transcript;
}
```

### System Prompt Design

The default system prompt emphasizes collective truth-seeking over winning. It establishes ground rules for productive multi-model debate:

```javascript
function buildSystemPrompt(topic) {
  return `You are participating in a multi-AI deliberation session.

**Topic**: ${topic}

**Your Role**:
- You are one of several AI participants (Claude, Gemini, Codex)
- Each AI brings different perspectives and training
- Your goal is collective truth-seeking, not winning

**Guidelines**:
1. Build on good ideas from others - give credit where due
2. Push back on weak reasoning - be specific about flaws
3. Avoid wishful thinking ("this could work if...") - be realistic
4. Add novel angles the others haven't considered
5. Be concise - quality over quantity
6. If you're uncertain, say so - don't pretend to know`;
}
```

### Consensus Extraction

After all rounds complete, the system extracts the final position of each agent:

```javascript
function extractConsensus(transcript) {
  const contributions = transcript.filter(t => t.role === 'agent' && !t.error);
  if (contributions.length === 0) return 'No consensus reached - all agents failed.';

  // Get last contribution from each agent
  const lastByAgent = {};
  for (const c of contributions) {
    lastByAgent[c.agent] = c.content;
  }

  return Object.entries(lastByAgent)
    .map(([agent, content]) => `**${agent}**: ${content.slice(0, 500)}...`)
    .join('\n\n');
}
```

### Transcript Formatting

The full deliberation is formatted as markdown for storage and human review:

```javascript
function formatTranscriptAsMarkdown(transcript, topic) {
  const lines = [`# AI Deliberation: ${topic}\n`];

  for (const entry of transcript) {
    if (entry.role === 'agent') {
      lines.push(`## ${entry.agent} (Round ${entry.round})`);
      lines.push(`*${entry.timestamp}*\n`);
      lines.push(entry.content);
      lines.push('\n---\n');
    }
  }

  return lines.join('\n');
}
```

### What Lives in Hivemind (Not Riley)

The standalone Hivemind CLI (`~/projects/hivemind`) implements additional modes that Riley does not:

- **Research mode**: Independent parallel research with a synthesis step
- **Fibonacci (reverse engineering)**: Iterative deepening to validate/refute a claim
- **Moderator mode**: A 4th AI directs the conversation
- **Team mode**: Models assigned roles (devil's advocate, domain expert, pragmatist)

Riley's `/api/hivemind` endpoint delegates to the Hivemind CLI for these modes. Riley's own `lib/deliberation/` only implements round-robin natively.

## Implications

- API cost scales as `agents * rounds`: 3 agents over 3 rounds = 9 API calls, each with a growing transcript
- Transcript growth is O(agents * rounds): by round 3, each agent receives the full history from rounds 1-2, making later contributions more expensive token-wise
- Agent failures are graceful: an error entry is added to the transcript but does not stop the deliberation. Other agents see the error and can note the gap
- The system works with as few as 1 agent (with a warning), but the value comes from 2+: a single agent just talks to itself
- Round-robin forces structured turn-taking, which prevents one model from dominating but also means agents cannot interrupt or ask clarifying questions mid-round
- Consensus extraction is naive: it takes each agent's last contribution, not a synthesis. For deeper consensus, the caller must use the Hivemind CLI's research mode
- Custom system prompts are supported, allowing the caller to specialize the deliberation for specific domains
- No persistent deliberation history within Riley: results are returned to the caller and not stored in a deliberation-specific table

## Code Example

```javascript
// Triggering a deliberation from Riley's API
const result = await runDeliberation({
  topic: 'Should we migrate the worker queue from in-memory to Redis?',
  mode: 'round-robin',
  rounds: 3,
  models: ['claude', 'gemini'],  // Optional: defaults to all available
  onTurn: ({ round, agent, status }) => {
    console.log(`Round ${round}: ${agent} is ${status}`);
  },
});

// result.consensus:
// **Claude**: Redis adds operational complexity but solves the restart-loss problem...
// **Gemini**: In-memory is fine at current scale. Consider Redis when you hit 10K tasks/day...

// result.markdown: Full formatted transcript
// result.agents: ['Claude', 'Gemini']
// result.rounds: 3

// For advanced modes (research, fib, team), use the Hivemind CLI:
// POST http://localhost:3847/api/hivemind
// { "topic": "...", "mode": "research", "context": "..." }
// This delegates to the standalone Hivemind project, not Riley's lib/deliberation/
```

## Related Patterns

- [Orchestrator-Worker Communication](./orchestrator-satellite-communication.md)
- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
- [Deliberative Alignment](./deliberative-alignment.md)
