# LLM Adapter Facade

> Type normalization layer that translates between provider-specific message formats so the message processor works with a single canonical representation regardless of which LLM is active.

## Problem

Different LLM providers use incompatible message and tool call formats. Gemini represents message content as `parts` arrays with role-keyed objects; Claude uses `content` blocks with typed entries. Tool invocations and their results are structured differently again between providers. Without a normalization layer, the message processor must branch on provider identity throughout its logic — every place that builds a message, reads a tool call, or parses a result becomes polluted with conditional formatting code. Switching providers or adding a new one means auditing the entire pipeline for hardcoded assumptions.

## Context

- An orchestrator integrates with two or more LLM providers (e.g., Gemini and Claude) and needs to switch between them at runtime
- The message processor maintains a conversation history that must survive a provider switch intact
- Tool call and tool result structures differ enough between providers that naive pass-through causes API errors
- The core message processing pipeline should have no knowledge of which provider is currently active
- New providers need to be onboarded without touching the pipeline

## Solution

Each LLM provider gets a dedicated adapter that exposes a single canonical interface to the message processor. The adapter handles translation in both directions: incoming messages from the processor are converted to the provider's wire format before the API call, and the provider's response is normalized back to the canonical format before it returns to the processor.

### Canonical Message Format

The pipeline always works with a provider-agnostic message structure:

```javascript
// lib/conversation/message-format.js
// Canonical representation — never provider-specific

// Text message
{ role: 'user', content: 'Hello' }
{ role: 'assistant', content: 'Hi there' }

// Tool call (outbound from LLM)
{ role: 'assistant', toolCalls: [{ id: 'call_1', name: 'search', args: { query: 'weather' } }] }

// Tool result (inbound to LLM)
{ role: 'tool', toolCallId: 'call_1', content: '{ "result": "sunny, 72°F" }' }
```

### Gemini Adapter

Gemini uses `parts` arrays and a distinct `functionCall` / `functionResponse` structure:

```javascript
// lib/conversation/adapters/gemini-adapter.js
class GeminiAdapter {
  toProviderFormat(canonicalMessages) {
    return canonicalMessages.map((msg) => {
      // Gemini uses 'model' instead of 'assistant', and wraps content in parts
      if (msg.role === 'assistant' && msg.toolCalls) {
        return {
          role: 'model',
          parts: msg.toolCalls.map((tc) => ({
            functionCall: { name: tc.name, args: tc.args },
          })),
        };
      }

      if (msg.role === 'tool') {
        return {
          role: 'user',
          parts: [{ functionResponse: { name: msg.name, response: { content: msg.content } } }],
        };
      }

      return {
        role: msg.role === 'assistant' ? 'model' : msg.role,
        parts: [{ text: msg.content }],
      };
    });
  }

  fromProviderFormat(geminiResponse) {
    const candidate = geminiResponse.candidates?.[0]?.content;
    if (!candidate) return { role: 'assistant', content: '' };

    const toolCalls = candidate.parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({ id: `call_${i}`, name: p.functionCall.name, args: p.functionCall.args }));

    if (toolCalls.length > 0) {
      return { role: 'assistant', toolCalls };
    }

    return {
      role: 'assistant',
      content: candidate.parts.filter((p) => p.text).map((p) => p.text).join(''),
    };
  }
}
```

### Claude Adapter

Claude uses typed `content` blocks and a separate `tool_use` / `tool_result` block type:

```javascript
// lib/conversation/adapters/claude-adapter.js
class ClaudeAdapter {
  toProviderFormat(canonicalMessages) {
    return canonicalMessages.map((msg) => {
      if (msg.role === 'assistant' && msg.toolCalls) {
        return {
          role: 'assistant',
          content: msg.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          })),
        };
      }

      if (msg.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }],
        };
      }

      return { role: msg.role, content: msg.content };
    });
  }

  fromProviderFormat(claudeResponse) {
    const toolUseBlocks = claudeResponse.content?.filter((b) => b.type === 'tool_use') ?? [];

    if (toolUseBlocks.length > 0) {
      return {
        role: 'assistant',
        toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, args: b.input })),
      };
    }

    const textContent = claudeResponse.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('') ?? '';

    return { role: 'assistant', content: textContent };
  }
}
```

### Facade Entry Point

The `claude-chat.js` module acts as the facade — it selects the right adapter for the active provider and presents a uniform interface to the message processor:

```javascript
// lib/conversation/claude-chat.js
class LLMChat {
  constructor(provider, config) {
    this.provider = provider;
    this.adapter = provider === 'gemini' ? new GeminiAdapter() : new ClaudeAdapter();
    this.history = []; // Always in canonical format
  }

  async sendMessage(canonicalMessages) {
    // Translate to provider wire format
    const providerMessages = this.adapter.toProviderFormat(
      [...this.history, ...canonicalMessages]
    );

    // Call the provider — adapter handles all format differences
    const raw = await this.provider.chat(providerMessages);

    // Normalize the response back to canonical
    const canonical = this.adapter.fromProviderFormat(raw);
    this.history.push(...canonicalMessages, canonical);
    return canonical;
  }
}
```

The message processor calls `chat.sendMessage(canonicalMessages)` and receives a canonical response — it never touches a `parts` array or a `tool_use` block directly.

## Implications

- Adding a new LLM provider requires writing one adapter class with two methods (`toProviderFormat` and `fromProviderFormat`) — the message processor, tool loop, and history management are untouched
- Conversation history is stored in canonical format, so switching providers mid-session is safe — the adapter translates the full history on each call
- The facade is the single point of coupling to provider APIs; version bumps or breaking changes in a provider SDK are contained to one file
- Tool call IDs must be preserved faithfully across the translation boundary — mismatches between a tool call's ID and its corresponding result will cause API errors that are difficult to trace
- Canonical format design is load-bearing: if it cannot represent a concept both providers need (e.g., multi-modal content, streaming deltas), the facade becomes leaky and adapters need special-case paths
- Testing the pipeline can use a mock adapter that returns canned canonical responses — no provider credentials needed

## Code Example

```javascript
// Wiring: message processor is completely provider-agnostic
const chat = new LLMChat('gemini', config);

// Processor works in canonical format throughout
const response = await chat.sendMessage([
  { role: 'user', content: 'What is the weather in Tokyo?' },
]);

// response is always canonical, regardless of active provider:
// { role: 'assistant', toolCalls: [{ id: 'call_0', name: 'get_weather', args: { city: 'Tokyo' } }] }

// Feed tool result back — same canonical format
const final = await chat.sendMessage([
  { role: 'tool', toolCallId: 'call_0', content: '{ "temp": "18°C", "condition": "overcast" }' },
]);

// Swap provider — history translates automatically
const chatV2 = new LLMChat('claude', config);
chatV2.history = chat.history; // canonical history is portable
```

## Related Patterns

- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
