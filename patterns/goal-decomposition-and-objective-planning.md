# Goal Decomposition and Objective Planning

> Multi-level goal breakdown with objective decomposition and strategy generation for autonomous action.

## Problem

High-level goals like "improve test coverage" or "clean up technical debt" are too abstract for an agent to act on directly. Without decomposition, the agent either does nothing (goal too vague) or takes unfocused random actions. A structured breakdown from goals to objectives to strategies to actions enables purposeful autonomous work.

## Context

Riley operates autonomously on long time horizons (hours to days). The autonomous agent cycle runs periodically and needs concrete, actionable tasks to execute. Goal decomposition bridges the gap between user-defined high-level goals and the specific actions the agent can take.

## Solution

Goals decompose through four levels:

1. **Goals** -- high-level desired outcomes set by the user (e.g., "improve Riley's reliability")
2. **Objectives** -- measurable sub-goals derived from each goal (e.g., "add error handling to all API routes")
3. **Strategies** -- approaches to achieve each objective (e.g., "audit routes without try/catch, add error middleware")
4. **Actions** -- concrete tasks the agent can execute (e.g., "add error handling to /api/tasks endpoint")

```js
// Goal decomposition flow
async function decomposeGoal(goal) {
  const objectives = await generateObjectives(goal);
  for (const objective of objectives) {
    const strategies = await generateStrategies(objective, goal);
    for (const strategy of strategies) {
      const actions = await generateActions(strategy, objective);
      await createTasks(actions);
    }
  }
}
```

The decomposition is LLM-driven -- each level uses the parent context to generate appropriate children. The autonomous agent cycle reviews active goals periodically, regenerates strategies when objectives stall, and produces new actions as prior ones complete.

## Implications

- **Goal persistence** -- goals survive across sessions and are reviewed periodically by the cycle
- **LLM-dependent decomposition** -- quality of breakdown depends on the model's understanding of the codebase and domain
- **Progressive refinement** -- strategies and actions are regenerated as context changes, not fixed at goal creation time
- **Integration with task system** -- generated actions become tasks in the standard task lifecycle

## Related Patterns

- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
