# Message Processing Pipeline

> Modular seven-stage pipeline from user input through context assembly, planning, tool execution, and verified response delivery.

## Problem

Processing a user message in an AI orchestrator isn't a single LLM call. It requires session management, command routing, context assembly, optional planning, iterative tool execution with caching and recovery, response verification, and post-processing. Without a structured pipeline, this logic becomes a monolith that's impossible to debug or extend.

## Context

- Messages arrive from multiple channels (web UI, Slack, Telegram, WebSocket)
- Each message needs context from memory, entities, and conversation history
- The LLM may request multiple tool calls before producing a final response
- Tool calls need deduplication, interception, caching, and autonomy checks
- Responses need correction, verification against execution plans, and post-processing
- Errors at any stage need graceful handling without losing the conversation

## Solution

### Pipeline Stages

The message processor follows seven stages with a modular tool execution subsystem:

```
Input → Session → Route → Context → Plan → [Tool Loop] → Verify → Respond
```

### Stage 1: Session and Thinking Setup

Initialize the LLM session and determine the reasoning depth needed:

```javascript
const model = await getModel();
const chat = await sessions.getOrCreate(userId, (opts) => model.startChat(opts));
const thinkingLevel = await thinking.determineThinkingLevel(textContent);
const thinkingConfig = thinking.applyThinkingMode(thinkingLevel, {});
```

### Stage 2: Command and Skill Routing

Check for direct commands or high-confidence skill matches before invoking the LLM:

```javascript
const cmdKey = message.toLowerCase().split(' ')[0];
if (commands[cmdKey]) {
  await commands[cmdKey](ctx);
  return;
}

// Embeddings-based skill matching
const routeResult = await router.route(textContent, { userId });
if (routeResult?.path === 'reflex' && routeResult.skill) {
  // High-confidence match — execute skill directly, skip LLM
  await routeResult.skill.execute(ctx);
  return;
}
```

### Stage 3: Parallel Context Assembly

Context, routing, and conversation history are fetched in parallel:

```javascript
const [routeResult, prepared, _saved] = await Promise.all([
  router.route(textContent, { userId }),
  simple ? null : prepareMessageWithContext(message, userId, correlationId),
  conversations.saveMessage(userId, { role: 'user', content: message }),
]);
```

### Stage 4: Planning Phase

For non-trivial messages, a planning layer analyzes intent, detects constraints, and injects execution hints:

```javascript
const planResult = await planning.generatePlan(textContent, {
  messageToSend,
  activeSituations,
  toolDeclarations,
}, { userId, correlationId });

if (planResult.shouldInject) {
  messageToSend = planning.injectPlanHints(messageToSend, planResult);
}
```

### Stage 5: Modular Tool Loop

The tool execution subsystem is split into an orchestrator and per-tool handler:

**Tool Loop Orchestrator** manages the iteration cycle:

```javascript
// tool-execution/tool-loop-orchestrator.js
async function runToolLoop(chat, initialResponse, userId, correlationId) {
  const executionStatus = { executed: [], queued: [], failed: [] };
  const allTexts = [];
  let response = initialResponse;

  while (response.functionCalls?.length > 0 && iterations < MAX_ITERATIONS) {
    // 1. Deduplicate identical calls in the same batch
    const seen = new Set();
    const uniqueCalls = functionCalls.filter((call) => {
      const key = `${call.name}:${JSON.stringify(call.args)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 2. Intercept and validate before execution
    const { accepted, corrections } = interceptToolCalls(uniqueCalls);

    // 3. Execute all accepted tools in parallel
    const results = await Promise.all(
      accepted.map((call) => executeSingleTool(call, userId, correlationId))
    );

    // 4. Collect text from intermediate responses (prevents truncation)
    if (response.text) allTexts.push(response.text);

    // 5. Feed results back to the LLM
    response = await chat.sendMessage(results.map((r) => r.response));
  }

  return { response, toolCallsLog, iterations, executionStatus };
}
```

**Single Tool Handler** executes individual tools with full lifecycle management:

```javascript
// tool-execution/single-tool-handler.js
async function executeSingleTool(call, userId, correlationId) {
  // 1. Cache check — skip execution for cached read-only tools (30s TTL)
  const cached = getCachedToolResult(call.name, call.args);
  if (cached) return cached;

  // 2. Autonomy check — confidence-based execution control
  const result = await withTimeoutFeedback(
    executeToolWithAutonomy(call.name, call.args, userId),
    call.name
  );

  // 3. Soft error detection — generate recovery hints for LLM self-correction
  if (result?.error) {
    const recoveryHint = generateRecoveryHint(call.name, call.args, result.error);
    result._retryHint = recoveryHint;
  }

  // 4. Cache result if tool is read-only
  cacheToolResult(call.name, call.args, result);

  // 5. Non-blocking: analytics, learning, vibe follow-ups
  trackToolExecution(call, result).catch(() => {});

  return { response: { functionResponse: { name: call.name, response: result } } };
}
```

### Stage 6: Response Verification

After the tool loop completes, responses are corrected and verified against the execution plan:

```javascript
text = applyResponseCorrections(text, executionStatus);

if (planResult?.shouldVerify) {
  const verification = await planning.verifyExecution(planResult, toolCallsLog, text);
  // Inject corrections if verification finds discrepancies
}
```

### Stage 7: Delivery and Post-Processing

The response is sent immediately; post-processing runs in the background:

```javascript
await sendParsedResponse(ctx, text, chatMessenger, correlationId);

// Non-blocking — user sees response before these run
handlePostProcessing(userId, textContent, text, toolCallsLog, correlationId)
  .catch(logError);
```

## Implications

- The modular tool execution subsystem allows independent testing and extension of caching, interception, and autonomy logic
- Deduplication before execution prevents wasted LLM calls when the model repeats itself
- Recovery hints enable self-correction without human intervention — the LLM learns from tool failures within the same conversation
- Text collection across all iterations prevents truncation when the LLM provides partial text between tool calls
- Cache TTL of 30 seconds balances freshness with cost — read-only tools like search benefit most
- Planning verification catches cases where the LLM claims success but tool execution actually failed

## Code Example

```javascript
// Simplified: complete pipeline from message to response
async function processMessage(ctx) {
  const { message, userId, correlationId } = ctx;

  // Stage 1-2: Session + routing
  const chat = await sessions.getOrCreate(userId);
  const route = await router.route(message, { userId });
  if (route?.path === 'reflex') return route.skill.execute(ctx);

  // Stage 3: Parallel context assembly
  const context = await prepareMessageWithContext(message, userId, correlationId);

  // Stage 4: Planning
  const plan = await planning.generatePlan(message, { context });
  const messageToSend = plan.shouldInject
    ? planning.injectPlanHints(context, plan) : context;

  // Stage 5: LLM dispatch + tool loop
  const initialResponse = await chat.sendMessage(messageToSend);
  const { response, toolCallsLog, executionStatus } = await runToolLoop(
    chat, initialResponse, userId, correlationId
  );

  // Stage 6: Verify
  let text = applyResponseCorrections(response.text, executionStatus);

  // Stage 7: Deliver + post-process
  await sendParsedResponse(ctx, text);
  handlePostProcessing(userId, message, text, toolCallsLog).catch(logError);
}
```

## Related Patterns

- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Declarative Capability System](./declarative-capability-system.md)
- [Channel Adapter Architecture](./channel-adapter-architecture.md)
- [Error Triage and Recovery](./error-triage-and-recovery.md)
