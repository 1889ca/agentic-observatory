# Autonomous Agent Cycle

> Periodic long-interval loop that reviews active objectives, generates strategies, and produces actionable tasks — running every 2 hours to maintain goal-directed behavior without continuous compute.

## Problem

An AI orchestrator that only responds to user messages is reactive — it waits idle between interactions. But a capable system should proactively pursue objectives, generate strategies for achieving them, and produce actions to execute. A continuous loop wastes compute when idle. A fast tick-based event processor is overkill for strategic planning, which only needs periodic review. What's needed is a long-interval cycle that periodically checks in on high-level goals and generates work from them.

## Context

- An orchestrator with access to project state, objectives, and external services
- Strategic planning is a slow process — reviewing objectives and generating strategies does not need sub-second latency
- The cycle must not interfere with interactive user requests
- Objectives change infrequently; strategies and actions are derived from them periodically

## Solution

### Periodic Objectives Review Loop

The agent cycle runs on a 2-hour interval. Each cycle reviews active objectives, evaluates progress, generates or updates strategies, and produces concrete actions:

```javascript
// agent/cycle.js
const CYCLE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function runCycle() {
  const objectives = await db.query(
    `SELECT * FROM objectives WHERE status = 'active'`
  );

  for (const objective of objectives.rows) {
    // Evaluate current progress against the objective
    const progress = await evaluateProgress(objective);

    // Generate or refine strategies based on current state
    const strategies = await generateStrategies(objective, progress);

    // Produce concrete actions from strategies
    const actions = await produceActions(objective, strategies);

    // Queue actions for execution
    for (const action of actions) {
      await queueAction(action);
    }
  }
}
```

### Objective Evaluation

Each objective is assessed for progress. Stalled or completed objectives are flagged:

```javascript
async function evaluateProgress(objective) {
  const recentActions = await db.query(
    `SELECT * FROM actions WHERE objective_id = $1 AND created_at > NOW() - INTERVAL '48 hours'`,
    [objective.id]
  );

  const completedCount = recentActions.rows.filter(a => a.status === 'completed').length;
  const failedCount = recentActions.rows.filter(a => a.status === 'failed').length;

  if (completedCount === 0 && failedCount > 0) {
    return { status: 'stalled', reason: 'recent actions all failed' };
  }

  if (await isObjectiveMet(objective)) {
    await db.query(`UPDATE objectives SET status = 'completed' WHERE id = $1`, [objective.id]);
    return { status: 'completed' };
  }

  return { status: 'in_progress', completedCount, failedCount };
}
```

### Strategy Generation

Strategies bridge the gap between high-level objectives and concrete actions. The cycle generates them by considering the objective's current state and what has been tried:

```javascript
async function generateStrategies(objective, progress) {
  if (progress.status === 'completed') return [];
  if (progress.status === 'stalled') {
    // Stalled objectives need new approaches
    return await generateAlternativeStrategies(objective);
  }

  // Normal progress: refine existing strategies
  const existing = await db.query(
    `SELECT * FROM strategies WHERE objective_id = $1 AND status = 'active'`,
    [objective.id]
  );

  if (existing.rows.length === 0) {
    return await generateInitialStrategies(objective);
  }

  return existing.rows;
}
```

### Action Production

Strategies are decomposed into concrete, dispatchable actions:

```javascript
async function produceActions(objective, strategies) {
  const actions = [];

  for (const strategy of strategies) {
    const nextSteps = await determineNextSteps(strategy);

    for (const step of nextSteps) {
      actions.push({
        objective_id: objective.id,
        strategy_id: strategy.id,
        type: step.type,
        prompt: step.prompt,
        workdir: step.workdir,
      });
    }
  }

  return actions;
}

async function queueAction(action) {
  await db.query(
    `INSERT INTO actions (objective_id, strategy_id, type, prompt, workdir, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [action.objective_id, action.strategy_id, action.type, action.prompt, action.workdir]
  );
}
```

### Startup and Shutdown

The cycle starts with an initial run and then repeats every 2 hours:

```javascript
async function startCycle() {
  // Run immediately on startup
  await runCycle();

  // Then repeat on interval
  const timer = setInterval(runCycle, CYCLE_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
```

## Implications

- The 2-hour interval means strategic changes take up to 2 hours to produce new actions — this is intentional for planning-level work, not real-time operations
- Separating objectives, strategies, and actions creates a clear hierarchy: objectives are stable, strategies adapt, actions are disposable
- Stalled objective detection prevents the system from endlessly retrying failed approaches — it triggers strategy regeneration instead
- The cycle is independent from interactive request handling — user messages are processed immediately through the normal dispatch path, not through this loop
- Actions produced by the cycle are queued like any other task, flowing through the standard dispatch and worker systems
- The long interval keeps compute costs minimal — the cycle is dormant 99%+ of the time

## Code Example

```javascript
// Start the autonomous agent cycle
if (process.env.RUN_AGENT_CYCLE) {
  const cycle = await startCycle();
  process.on('SIGTERM', () => cycle.stop());
}

// Example cycle execution:
// 1. Reviews 3 active objectives
// 2. Objective "reduce billing-api error rate" — in_progress, 2 completed actions
//    -> Strategy: "add retry logic to /invoices endpoint"
//    -> Action queued: { type: 'solve-issue', prompt: 'Add retry logic to...' }
// 3. Objective "migrate to postgres 16" — stalled, all recent actions failed
//    -> Generates alternative strategy: "attempt migration with pg_upgrade instead"
//    -> Action queued: { type: 'coding', prompt: 'Set up pg_upgrade migration...' }
// 4. Objective "improve test coverage" — completed
//    -> Marked completed, no actions produced
```

## Related Patterns

- [Cognitive Processing Loop](./cognitive-processing-loop.md)
- [Outbound Queue with Backoff](./outbound-queue-with-backoff.md)
- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
