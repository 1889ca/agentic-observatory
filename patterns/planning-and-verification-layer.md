# Planning and Verification Layer

> Pre-execution plan generation with post-execution verification, novel composition detection, and automatic skill generation.

## Problem

An agent that jumps straight from intent to execution operates blind. It may invoke tools in the wrong order, miss dependencies between steps, or produce results that silently diverge from what the user expected. Without a plan, there's no way to detect partial failures — the agent reports "done" when it's only completed 3 of 5 necessary steps. Without verification, there's no feedback loop to improve future executions. And without novelty detection, the system can't learn from creative tool compositions that emerge organically during complex tasks.

## Context

- An orchestrator with access to multiple tools and multi-step task execution
- Tasks that require coordination between tools with ordering constraints
- A need to detect when execution results diverge from expectations
- Historical execution data available for comparison against novel compositions
- A desire for the system to learn new capabilities from successful executions

## Solution

### Plan Generation

Before executing any multi-step task, the agent generates a structured execution plan. The plan specifies tools, expected inputs/outputs, ordering constraints, and risk flags:

```javascript
async function generatePlan(intent, context) {
  const plan = await llm.complete({
    system: `Generate an execution plan as structured JSON. Include:
      - steps: ordered list of tool invocations
      - dependencies: which steps depend on which
      - expected_outcomes: what success looks like per step
      - risks: what could go wrong and fallback strategies`,
    messages: [{ role: 'user', content: intent }],
    tools: getAvailableTools(),
    response_format: { type: 'json_object' }
  });

  return {
    id: crypto.randomUUID(),
    intent,
    steps: plan.steps,
    dependencies: buildDependencyGraph(plan.steps),
    expectedOutcomes: plan.expected_outcomes,
    risks: plan.risks,
    signature: computeToolSignature(plan.steps),
    createdAt: Date.now()
  };
}

function computeToolSignature(steps) {
  return steps.map(s => s.tool).join(' -> ');
}
```

### Execution with Checkpoints

Each step in the plan executes with its result captured for later verification:

```javascript
async function executePlan(plan) {
  const results = new Map();

  for (const step of topologicalSort(plan.steps, plan.dependencies)) {
    const inputs = resolveInputs(step, results);

    try {
      const result = await executeTool(step.tool, inputs);
      results.set(step.id, { status: 'success', output: result });
    } catch (error) {
      results.set(step.id, { status: 'failed', error });

      if (step.critical) {
        return { plan, results, status: 'aborted', failedAt: step.id };
      }
    }
  }

  return { plan, results, status: 'completed' };
}
```

### Post-Execution Verification

After execution completes, a verification pass compares actual outcomes against the plan's expected outcomes:

```javascript
async function verifyExecution(execution) {
  const { plan, results } = execution;
  const discrepancies = [];

  for (const step of plan.steps) {
    const expected = plan.expectedOutcomes[step.id];
    const actual = results.get(step.id);

    if (!actual || actual.status === 'failed') {
      discrepancies.push({
        step: step.id,
        type: 'missing_result',
        expected,
        actual: actual?.error?.message || 'no result'
      });
      continue;
    }

    const match = await compareOutcomes(expected, actual.output);
    if (match.score < 0.7) {
      discrepancies.push({
        step: step.id,
        type: 'outcome_mismatch',
        expected,
        actual: actual.output,
        matchScore: match.score,
        explanation: match.explanation
      });
    }
  }

  return {
    verified: discrepancies.length === 0,
    discrepancies,
    overallScore: computeVerificationScore(plan.steps, discrepancies)
  };
}
```

### Novel Composition Detection

When a plan's tool signature hasn't been seen before, it's flagged as a novel composition. Successful novel compositions become candidates for skill extraction:

```javascript
async function detectNovelty(plan, verification) {
  const signature = plan.signature;
  const known = await signatureStore.find(signature);

  if (known) {
    known.occurrences += 1;
    known.lastSeen = Date.now();
    await signatureStore.update(known);
    return { novel: false, signature };
  }

  const entry = {
    signature,
    intent: plan.intent,
    steps: plan.steps,
    verified: verification.verified,
    verificationScore: verification.overallScore,
    occurrences: 1,
    firstSeen: Date.now()
  };

  await signatureStore.insert(entry);

  if (verification.verified && verification.overallScore > 0.9) {
    await skillCandidateQueue.enqueue({
      signature,
      plan,
      score: verification.overallScore
    });
  }

  return { novel: true, signature, skillCandidate: verification.overallScore > 0.9 };
}
```

### Skill Generation from Novel Compositions

When a novel composition succeeds repeatedly, it's promoted into a reusable skill:

```javascript
async function promoteToSkill(signature) {
  const history = await signatureStore.find(signature);

  if (history.occurrences < 5 || !history.verified) return null;

  const executions = await executionLog.findBySignature(signature);
  const successRate = executions.filter(e => e.verified).length / executions.length;

  if (successRate < 0.85) return null;

  const skill = {
    name: await generateSkillName(history.intent),
    signature,
    steps: history.steps,
    paramSchema: inferParamSchema(executions),
    promotedAt: Date.now(),
    sourceExecutions: executions.length
  };

  await skillRegistry.register(skill);
  return skill;
}
```

## Implications

- Plan generation adds latency before execution — typically 1-2 seconds for LLM-based planning
- Verification is only as good as the expected outcome descriptions; vague expectations yield false positives
- Novel composition detection requires maintaining a signature store that grows over time
- Auto-generated skills may encode incidental patterns rather than meaningful reusable workflows
- The planning step can itself fail or produce nonsensical plans — a meta-verification layer helps but adds complexity
- Tool signature comparison is brittle to minor variations in step ordering that produce equivalent results

## Code Example

```javascript
// Full orchestration: plan, execute, verify, learn
async function handleTask(intent, context) {
  const plan = await generatePlan(intent, context);

  // Optional: let the user review high-risk plans
  if (plan.risks.some(r => r.severity === 'high')) {
    const approved = await requestApproval(plan);
    if (!approved) return { status: 'rejected', plan };
  }

  const execution = await executePlan(plan);
  const verification = await verifyExecution(execution);
  const novelty = await detectNovelty(plan, verification);

  if (novelty.novel && novelty.skillCandidate) {
    await promoteToSkill(plan.signature);
  }

  return { execution, verification, novelty };
}
```

## Related Patterns

- [Message Processing Pipeline](./message-processing-pipeline.md)
- [Skill Extraction and Fast-Path Routing](./skill-extraction-and-fast-path-routing.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
