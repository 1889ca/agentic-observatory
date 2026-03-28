# LLM Adapter Facade

> Unified multi-provider LLM facade with task-type routing, complexity-based model selection, automatic fallback chains, cost tracking, and one-directional Gemini-to-Claude tool format conversion.

## Problem

Different LLM providers use incompatible APIs, pricing models, and tool call formats. Gemini represents tool declarations as `functionDeclarations`; Claude uses `input_schema` blocks. Each provider has different rate limits, strengths, and cost profiles. Without a unified facade, every module that needs LLM generation must handle provider selection, format conversion, fallback logic, and cost tracking independently. Adding a new provider means touching every consumer.

## Context

- An orchestrator integrates with three LLM providers: Gemini (primary, via both Vertex AI and consumer API), Claude (via Anthropic SDK), and OpenAI
- Different tasks have different ideal providers — extraction is cheap on Gemini, complex reasoning benefits from Claude
- Rate limits and outages are common — the system must fall back gracefully
- Tool declarations are authored in Gemini format; Claude calls require conversion
- LLM cost must be tracked per-provider, per-model, and per-feature for budget management

## Solution

### Unified Generation Interface

The `lib/llm/index.js` facade presents a single `generate()` function that handles routing, provider selection, retry, fallback, and cost tracking:

```javascript
// lib/llm/index.js
const gemini = require('./providers/gemini')
const claude = require('./providers/claude')
const openai = require('./providers/openai')
const router = require('./router')
const costTracker = require('./cost-tracker')

async function generate(request) {
  // Route the request based on task type, complexity, feature name
  const routing = router.route(request)

  const providers = { gemini, claude, openai }
  const provider = providers[routing.provider] || gemini

  const enrichedRequest = {
    ...request,
    model: request.model || routing.model,
  }

  let response
  let usedFallback = false

  try {
    response = await retryWithBackoff(
      () => provider.generate(enrichedRequest),
      request.maxRetries ?? 2
    )
  } catch (err) {
    // Rate limit → try fallback chain: Gemini → Claude → OpenAI
    const isRateLimit = err.message?.includes('429') ||
      err.message?.includes('RESOURCE_EXHAUSTED')

    if (isRateLimit && routing.provider === 'gemini') {
      if (claude.isAvailable()) {
        response = await claude.generate({ ...enrichedRequest, model: models.CLAUDE_MODEL })
        usedFallback = true
      } else if (openai.isAvailable()) {
        response = await openai.generate({ ...enrichedRequest, model: models.OPENAI_MODEL })
        usedFallback = true
      } else {
        throw err
      }
    } else {
      throw err
    }
  }

  // Track cost
  costTracker.record({
    provider: response.provider,
    model: response.model,
    usage: response.usage,
    cost: response.cost,
    featureName: request.featureName,
  })

  return { ...response, routing: usedFallback
    ? { ...routing, fallback: true, originalProvider: routing.provider }
    : routing }
}
```

### Task-Type and Complexity-Based Routing

The router (`lib/llm/router.js`) selects provider and model tier based on a priority chain:

1. Extended thinking request → Claude advanced
2. Explicit provider preference (`preferClaude`, `preferGemini`, `preferOpenAI`)
3. Feature-specific routing (feature name in Claude-required or Gemini-preferred sets)
4. Task-type routing (planning → Claude, extraction → Gemini fast)
5. Complexity-based routing (heuristic 0-1 score from prompt analysis)
6. Default → Gemini at appropriate tier

```javascript
// lib/llm/router.js
const CLAUDE_REQUIRED_FEATURES = new Set([
  'goal_decomposition', 'strategy_planning', 'weekly_synthesis',
  'code_review', 'architecture_planning', 'daily_reflection',
])

const GEMINI_PREFERRED_FEATURES = new Set([
  'email_triage', 'entity_extraction', 'fact_extraction',
  'classification', 'conversation_summary', 'translation',
])

function route(request) {
  const { taskType, featureName, complexity, preferClaude } = request

  // Feature-specific routing
  if (featureName && CLAUDE_REQUIRED_FEATURES.has(featureName)) {
    return claude.isAvailable()
      ? { provider: 'claude', model: models.claude.standard, reason: 'feature_requires_claude' }
      : { provider: 'gemini', model: models.gemini.advanced, reason: 'claude_unavailable_fallback' }
  }

  // Task type routing
  if (taskType && ROUTING_RULES.taskTypes[taskType]) {
    const rule = ROUTING_RULES.taskTypes[taskType]
    return { provider: rule.provider, model: models[rule.provider][rule.tier] }
  }

  // Complexity-based
  const score = complexity ?? estimateComplexity(request)
  if (score >= CLAUDE_THRESHOLD && claude.isAvailable()) {
    return { provider: 'claude', model: models.claude.standard, complexity: score }
  }

  return { provider: 'gemini', model: models.gemini[tierFromComplexity(score)] }
}
```

### One-Directional Tool Format Conversion

Tool declarations are authored in Gemini format. The Claude provider converts them on the fly — there is no bidirectional adapter or canonical format layer:

```javascript
// lib/llm/providers/claude.js
function convertToolsToClaudeFormat(geminiTools) {
  if (!geminiTools || geminiTools.length === 0) return undefined

  return geminiTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: tool.parameters?.properties || {},
      required: tool.parameters?.required || [],
    },
  }))
}
```

This is intentionally one-directional. The codebase standardizes on Gemini's tool declaration format because Gemini is the primary provider. Claude calls convert on entry; no conversion is needed for Gemini calls.

### Convenience Methods

The facade provides shortcut methods for common patterns:

```javascript
// lib/llm/index.js

// Quick extraction/classification (Gemini fast model)
async function quick(prompt, options = {}) {
  return generate({
    prompt, preferGemini: true,
    taskType: TASK_TYPES.EXTRACTION,
    model: models.FALLBACK_MODEL,
    ...options,
  })
}

// Deep reasoning (Claude)
async function think(prompt, options = {}) {
  return generate({
    prompt, preferClaude: true,
    taskType: TASK_TYPES.PLANNING,
    ...options,
  })
}

// JSON response with automatic parsing
async function generateJson(request) {
  const response = await generate({
    ...request,
    generationConfig: { responseMimeType: 'application/json' },
  })
  response.json = parseJson(response.text)
  return response
}
```

### Cost Tracking

Every generation records provider, model, token counts, and computed cost to an in-memory tracker that flushes to the database periodically:

```javascript
// lib/llm/cost-tracker.js
const stats = {
  gemini: { tokens: { input: 0, output: 0 }, cost: 0, requests: 0 },
  claude: { tokens: { input: 0, output: 0 }, cost: 0, requests: 0 },
  byFeature: {},
  byModel: {},
  sessionStart: Date.now(),
}
```

### Gemini Dual-Backend

The Gemini provider itself has two backends: Vertex AI (higher rate limits, GCP auth) and the consumer API (`@google/generative-ai`). It routes to Vertex when `VERTEX_PROJECT_ID` is set, falling back to the consumer API otherwise. Model names are mapped between the two backends automatically.

## Implications

- Adding a new provider requires a new file in `lib/llm/providers/` implementing `generate()` and `isAvailable()` — the router and facade need only a one-line addition
- One-directional tool conversion is simpler than a canonical format but means Claude tool results must be post-processed back to Gemini format if the conversation continues on Gemini
- The fallback chain (Gemini → Claude → OpenAI) means rate limits on the primary provider cause automatic escalation to more expensive providers — cost spikes are possible during Gemini outages
- Feature-based routing is explicit (hardcoded sets) rather than learned — adding a new feature that needs Claude requires a code change
- Complexity estimation is heuristic (prompt length + keyword patterns) — it can misroute edge cases, but the cost of a wrong tier is low
- Cost tracking is per-session in memory; the `flush()` method must be called to persist — a crash loses unflushed stats

## Code Example

```javascript
// Module using the facade — no provider awareness
const llm = require('../llm')

// Quick extraction (routes to Gemini fast)
const entities = await llm.quick('Extract all person names from: ...')

// Deep analysis (routes to Claude)
const plan = await llm.think('Analyze the trade-offs between...')

// Feature-specific (router decides provider)
const summary = await llm.generate({
  prompt: 'Summarize today\'s emails...',
  featureName: 'email_triage',  // Gemini-preferred
  taskType: llm.TASK_TYPES.SUMMARIZATION,
})

// JSON with tools
const result = await llm.generateJson({
  prompt: 'Classify this support ticket...',
  tools: [{ name: 'classify', parameters: { properties: { category: { type: 'string' } } } }],
})

// Check usage
console.log(llm.getUsageSummary())
```

## Related Patterns

- [Model Selection and LLM Fallback](./model-selection-and-llm-fallback.md)
- [Semantic Query Routing](./semantic-query-routing.md)
- [Tunable Runtime Configuration](./tunable-runtime-configuration.md)
