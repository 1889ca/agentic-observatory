# Message Processing Pipeline

> End-to-end flow from user input through context assembly, LLM dispatch, iterative tool execution, and response delivery.

## Problem

Processing a user message in an AI orchestrator isn't a single LLM call. It requires assembling relevant context from memory and conversation history, dispatching to the right model, handling tool calls in a loop, applying post-processing, and delivering the response across multiple channels. Without a structured pipeline, this logic becomes a tangled monolith that's impossible to debug or extend.

## Context

- Messages arrive from multiple channels (web UI, Slack, Telegram, email, WebSocket)
- Each message needs context from memory, entities, and conversation history
- The LLM may request multiple tool calls before producing a final response
- Responses need post-processing (corrections, formatting, learning extraction)
- Errors at any stage need graceful handling without losing the conversation

## Solution

### Pipeline Stages

The message processor follows a linear pipeline with a tool-call loop:

```
Input → Extract → Context → Dispatch → [Tool Loop] → Post-Process → Respond
```

**1. Extract** — Normalize the incoming message. Text, images, and files are extracted into a uniform content structure regardless of source channel.

**2. Context Assembly** — Build the LLM prompt with relevant background:

```javascript
async function assembleContext(message) {
  const [memory, entities, history] = await Promise.all([
    semanticSearch(message.text, { budget: tokenBudget }),
    getRelevantEntities(message),
    getConversationHistory(message.conversationId, { limit: 20 })
  ]);
  return buildPrompt({ memory, entities, history, message });
}
```

Budget-aware assembly ensures the total context stays within model limits. Different dispatch types get different budgets — a quick user query gets 600 tokens of context; a reflective analysis gets 3000.

**3. Dispatch** — Send to the LLM with capability declarations:

```javascript
const response = await model.generate({
  systemInstruction: systemPrompt,   // Includes learned anti-patterns
  contents: assembledContext,
  tools: capabilities.getDeclarations()  // 225+ tool declarations
});
```

**4. Tool Loop** — If the LLM returns tool calls, execute them and feed results back:

```javascript
while (response.hasToolCalls()) {
  const results = [];
  for (const call of response.toolCalls) {
    const result = await capabilities.execute(call.name, call.params);
    results.push({ callId: call.id, result });
  }
  response = await model.generate({
    contents: [...context, ...toolResults(results)],
    tools: declarations
  });
}
```

The loop continues until the LLM produces a text response with no further tool calls. A maximum iteration guard prevents infinite loops.

**5. Post-Process** — After the final response:
- Apply learned corrections (typo fixes, terminology normalization)
- Extract actions for audit logging
- Record confidence scores
- Trigger learning extraction (fire-and-forget)

**6. Respond** — Deliver via the originating channel's adapter.

### Thinking Mode

A special `/think` command enables extended reasoning. When active, the LLM is given additional thinking tokens and the response includes the reasoning chain alongside the final answer.

### Approval Flow

If a tool call requires human approval (based on autonomy tier), the pipeline pauses, sends an approval request to the user, and resumes when approved or denied.

## Implications

- The tool loop is the most complex part — each iteration is a full LLM call with accumulated context
- Context assembly is the primary latency contributor (memory search, entity lookup)
- Tool loop iterations multiply cost linearly — a 5-tool conversation costs 5x a simple response
- Post-processing runs after the user sees the response (fire-and-forget) to avoid latency
- Channel adapters must handle message formatting differences (Slack markdown vs. HTML vs. plain text)
- Conversation history accumulates — needs truncation strategy for long sessions

## Code Example

```javascript
// Core message processing pipeline
async function processMessage(message) {
  // 1. Extract
  const content = extractContent(message);

  // 2. Context
  const thinkingMode = detectThinkingMode(content);
  const context = await assembleContext(content, {
    budget: thinkingMode ? 3000 : 600
  });

  // 3. Dispatch + 4. Tool Loop
  let response = await dispatch(context);
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (response.hasToolCalls() && iterations++ < MAX_ITERATIONS) {
    const results = await executeToolCalls(response.toolCalls);
    response = await dispatch([...context, ...results]);
  }

  // 5. Post-process (non-blocking)
  postProcess(message, response).catch(logError);

  // 6. Respond
  await message.channel.send(formatResponse(response));
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
