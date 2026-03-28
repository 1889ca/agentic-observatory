# Deliberative Alignment

> General-purpose round-robin multi-model deliberation where Claude, Gemini, and Codex debate a topic across multiple rounds, building on each other's ideas to reach natural language consensus.

## Problem

A single AI model has blind spots baked into its training. When an agent needs to reason about ambiguous topics -- architectural decisions, strategic tradeoffs, creative problems -- one model's perspective is inherently limited. Using multiple models independently and picking the "best" answer discards the value of models challenging and refining each other's reasoning. The system needs structured multi-model debate, not parallel monologues.

## Context

- Multiple AI models available as CLI tools (Claude, Gemini, Codex) with different training, perspectives, and failure modes
- Topics are open-ended and benefit from genuine deliberation, not binary EXECUTE/QUEUE voting
- Each model should build on, challenge, and refine what others have said -- not respond in isolation
- The system must degrade gracefully when fewer models are available (minimum 1, optimal 2+)
- Deliberation is a general-purpose capability invoked by user request, scheduled tasks, or system components -- not tied to any specific decision framework

## Solution

### Agent Architecture

Each AI model is wrapped in an agent class that extends `BaseAgent`. The base class defines the interface: `isAvailable()` checks if the CLI tool exists, and `think()` takes the conversation so far plus a system prompt and returns a contribution. The prompt template instructs the agent to advance the conversation, not repeat what has been said:

```javascript
class BaseAgent {
  constructor(name, color) {
    this.name = name
    this.color = color
  }

  buildPrompt(conversationContext, systemPrompt) {
    return `${systemPrompt}

## Conversation So Far

${conversationContext}

---

Your turn. Read what the others have said, build on their ideas,
push back where you disagree, and add something novel.
Be concise but substantive. Don't repeat what's been said -
advance the conversation.`
  }
}
```

Three concrete agents wrap their respective CLI tools:

```javascript
class ClaudeAgent extends BaseAgent {
  constructor() { super('Claude', '\x1b[35m') }

  async isAvailable() {
    return new Promise(resolve => {
      const proc = spawn('which', ['claude'])
      proc.on('close', code => resolve(code === 0))
    })
  }

  async think(conversationContext, systemPrompt) {
    const proc = spawn('claude', ['-p', '-', '--output-format', 'text'])
    // ... pipe fullPrompt to stdin, collect stdout
    return { response: stdout.trim(), metadata: { agent: 'claude' } }
  }
}

class GeminiAgent extends BaseAgent {
  constructor() { super('Gemini', '\x1b[34m') }
  // Uses: spawn('gemini', [fullPrompt])
}

class CodexAgent extends BaseAgent {
  constructor() { super('Codex', '\x1b[32m') }
  // Uses: spawn('codex', [fullPrompt])
}
```

### Round-Robin Deliberation

The core algorithm is round-robin: each agent takes turns in sequence across multiple rounds. Crucially, each agent sees the full transcript of everything said before it, enabling genuine debate rather than isolated responses:

```javascript
async function runRoundRobin({ topic, agents, rounds = 3, systemPrompt, onTurn }) {
  const prompt = systemPrompt || buildSystemPrompt(topic)
  const transcript = []

  transcript.push({
    role: 'system',
    content: `# Deliberation: ${topic}\n\n${prompt}`,
    timestamp: new Date().toISOString(),
  })

  for (let round = 1; round <= rounds; round++) {
    for (const agent of agents) {
      if (onTurn) onTurn({ round, agent: agent.name, status: 'thinking' })

      // Build context from all previous contributions
      const context = transcript
        .filter(t => t.role !== 'system')
        .map(t => `## ${t.agent} (${t.timestamp})\n\n${t.content}`)
        .join('\n\n---\n\n')

      const result = await agent.think(context || '(No conversation yet)', prompt)

      transcript.push({
        role: 'agent',
        agent: agent.name,
        content: result.response,
        timestamp: new Date().toISOString(),
        round,
      })
    }
  }

  return transcript
}
```

With 3 agents and 3 rounds, this produces 9 contributions. The first agent in round 1 speaks into silence. By round 3, every agent has seen 6-8 prior contributions and can synthesize, challenge, or build.

### System Prompt Design

The deliberation prompt sets ground rules for productive multi-model debate. It prioritizes collective truth-seeking over winning, demands specific pushback on weak reasoning, and explicitly discourages both wishful thinking and excessive pessimism:

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
4. Avoid excessive pessimism ("this will never work") - be constructive
5. Add novel angles the others haven't considered
6. Be concise - quality over quantity
7. If you agree, say so briefly and move the conversation forward
8. If you're uncertain, say so - don't pretend to know`
}
```

### Consensus Extraction

After deliberation completes, the system extracts each agent's final position (their last contribution). This represents natural language consensus -- or documented disagreement -- rather than a binary vote:

```javascript
function extractConsensus(transcript) {
  const contributions = transcript.filter(t => t.role === 'agent' && !t.error)

  const lastByAgent = {}
  for (const c of contributions) {
    lastByAgent[c.agent] = c.content
  }

  return Object.entries(lastByAgent)
    .map(([agent, content]) => `**${agent}**: ${content.slice(0, 500)}...`)
    .join('\n\n')
}
```

### Main Entry Point

The `runDeliberation` function is the public API. It discovers available agents, runs the deliberation, extracts consensus, and formats everything as markdown:

```javascript
async function runDeliberation({
  topic,
  mode = 'round-robin',
  rounds = 3,
  models,
  systemPrompt,
  onTurn,
}) {
  let agents
  if (models && models.length > 0) {
    agents = await getAgentsByName(models)
  } else {
    agents = await getAvailableAgents()
  }

  if (agents.length === 0) {
    throw new Error('No AI agents available. Install at least one of: claude, gemini, codex')
  }

  const transcript = await runRoundRobin({ topic, agents, rounds, systemPrompt, onTurn })
  const consensus = extractConsensus(transcript)
  const markdown = formatTranscriptAsMarkdown(transcript, topic)

  return { consensus, transcript, markdown, agents: agents.map(a => a.name), rounds, mode }
}
```

### Error Resilience

If an agent fails mid-deliberation (CLI crash, timeout, network error), its contribution is recorded as an error entry. The deliberation continues with remaining agents -- a 3-agent session degrades to 2-agent rather than failing entirely:

```javascript
try {
  const result = await agent.think(context, prompt)
  transcript.push({ role: 'agent', agent: agent.name, content: result.response, round })
} catch (err) {
  transcript.push({
    role: 'agent', agent: agent.name,
    content: `[Error: ${err.message}]`,
    round, error: true,
  })
}
```

### Markdown Transcript

The full deliberation is formatted as a readable markdown document with round markers and timestamps, suitable for storage, review, or inclusion in other documents:

```javascript
function formatTranscriptAsMarkdown(transcript, topic) {
  const lines = [`# AI Deliberation: ${topic}\n`]

  for (const entry of transcript) {
    if (entry.role === 'agent') {
      lines.push(`## ${entry.agent} (Round ${entry.round})`)
      lines.push(`*${entry.timestamp}*\n`)
      lines.push(entry.content)
      lines.push('\n---\n')
    }
  }

  return lines.join('\n')
}
```

## Implications

- Latency scales linearly: 3 agents x 3 rounds = 9 sequential LLM calls, each potentially 10-30 seconds -- total deliberation can take 2-5 minutes
- Agents spawn CLI processes, meaning each model must be installed as a system CLI tool -- not called via API
- The round-robin structure means agent order matters: the first agent sets the frame, which later agents react to. Different orderings can produce different outcomes
- A moderator mode (where a 4th AI decides who speaks next) is declared but not yet implemented -- it falls back to round-robin
- Consensus extraction is naive: it takes each agent's last statement. True consensus detection (identifying agreement points vs. persistent disagreements) would require another LLM pass
- Single-agent deliberation is allowed with a warning -- it functions as a structured self-reflection rather than true debate
- Custom system prompts can override the default guidelines, allowing deliberation to be repurposed for specific domains
- The `onTurn` callback enables real-time progress updates (useful for streaming deliberation status to a UI)
- No result caching -- deliberating the same topic twice produces different results, which may or may not be desirable

## Code Example

```javascript
const { runDeliberation } = require('./lib/deliberation')

// Full deliberation with all available models
const result = await runDeliberation({
  topic: 'Should we migrate from PostgreSQL to a multi-model database?',
  rounds: 3,
  onTurn: ({ round, agent, status }) => {
    console.log(`Round ${round}: ${agent} is ${status}`)
  },
})

console.log(result.consensus)
// **Claude**: After considering Gemini's point about operational complexity...
// **Gemini**: I agree with Claude that the migration risk outweighs...
// **Codex**: The consensus seems right for the current scale, but...

console.log(result.markdown)
// Full formatted transcript with all 9 contributions

// Targeted deliberation with specific models
const focused = await runDeliberation({
  topic: 'Review this API design for security concerns',
  models: ['claude', 'gemini'],
  rounds: 2,
  systemPrompt: 'Focus exclusively on security implications. Be adversarial.',
})
```

## Related Patterns

- [Multi-Model Deliberation](./multi-model-deliberation.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [LLM Adapter Facade](./llm-adapter-facade.md)
- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
