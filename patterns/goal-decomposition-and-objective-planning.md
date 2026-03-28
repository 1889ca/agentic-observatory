# Goal Decomposition and Objective Planning

> AI-driven goal breakdown directly into actionable todos with dependency tracking, effort estimation, and auto-decomposition on goal creation.

## Problem

High-level goals like "launch the new API" or "improve test coverage to 80%" are too abstract for an agent to act on directly. Without decomposition, the agent either does nothing (goal too vague) or takes unfocused actions. Users set goals but often don't break them into actionable steps -- that's cognitive overhead that an AI agent can absorb. The decomposition needs to produce real, trackable tasks (not abstract layers) that integrate with the existing task system.

## Context

- An AI agent that operates autonomously and needs concrete tasks to execute
- Goals are stored as documents (type `goal`) in the document-tasks system, alongside regular todos
- The Gemini API is available for LLM-driven analysis and decomposition
- Generated tasks should integrate with the standard task lifecycle (pending, in_progress, completed)
- Goals may have target dates, project associations, and codebase context
- Past goal completion patterns can inform estimates for new goals

## Solution

### Direct Goal-to-Todo Decomposition

Goals decompose directly into actionable todos -- there are no intermediate "objective" or "strategy" layers. This keeps the system simple and produces immediately actionable output:

```javascript
// lib/goals/decomposition.js
async function decomposeGoal(goalId, { maxTodos = 8, codebaseContext = null } = {}) {
  const goal = await goals.getById(goalId);
  if (!goal) throw new Error(`Goal ${goalId} not found`);

  // Gather project context if available
  let projectContext = '';
  if (goal.projectId) {
    const project = await projects.getById(goal.projectId);
    if (project) {
      projectContext = `\nProject: ${project.name}`;
      if (project.codebasePath) projectContext += `\nCodebase: ${project.codebasePath}`;
    }
  }

  const prompt = `You are Riley, a personal assistant helping break down a goal into actionable tasks.

GOAL: ${goal.title}
${goal.description ? `DESCRIPTION: ${goal.description}` : ''}
${goal.targetDate ? `TARGET DATE: ${goal.targetDate}` : ''}${projectContext}

Break this goal into ${maxTodos} or fewer specific, actionable tasks. For each task:
1. Make it concrete and actionable (start with a verb)
2. Estimate effort in hours (be realistic)
3. Identify any dependencies on other tasks
4. Assign priority (1=low, 2=medium, 3=high, 4=critical)

Respond in JSON format:
{
  "analysis": "Brief analysis of what this goal requires",
  "totalEstimatedHours": <number>,
  "blockers": ["potential blocker 1", ...] or [],
  "tasks": [
    {
      "title": "Task title (start with verb)",
      "description": "Brief description",
      "estimatedHours": <number>,
      "priority": <1-4>,
      "dependsOn": [<index of dependency tasks>] or [],
      "category": "research|design|implementation|testing|documentation|other"
    }
  ],
  "suggestedOrder": [<indices in suggested execution order>]
}

Be specific to THIS goal. Don't be generic.`;

  const m = getModel(); // Gemini via GoogleGenerativeAI
  const result = await m.generateContent(prompt);
  const decomposition = JSON.parse(extractJSON(result.response.text()));

  // Create todos in suggested execution order
  const createdTodos = [];
  const todoIdMap = {};
  const order = decomposition.suggestedOrder || decomposition.tasks.map((_, i) => i);

  for (const idx of order) {
    const task = decomposition.tasks[idx];

    // Resolve dependency IDs
    const dependencies = (task.dependsOn || [])
      .map((depIdx) => todoIdMap[depIdx])
      .filter(Boolean);

    const todo = await tasks.create({
      title: task.title,
      description: buildTodoDescription(task, goal, dependencies),
      priority: task.priority || 2,
      taskType: 'todo',
      projectId: goal.projectId,
      dueDate: calculateDueDate(goal.targetDate, task, order.indexOf(idx), order.length),
    });

    todoIdMap[idx] = todo.id;
    createdTodos.push({ id: todo.id, title: task.title, estimatedHours: task.estimatedHours });
  }

  // Mark goal as decomposed
  await goals.update(goalId, {
    description: `${goal.description || ''}\n\n[Decomposed into ${createdTodos.length} tasks]`.trim(),
  });

  return {
    goalId,
    analysis: decomposition.analysis,
    totalEstimatedHours: decomposition.totalEstimatedHours,
    blockers: decomposition.blockers || [],
    todosCreated: createdTodos.length,
    todos: createdTodos,
  };
}
```

### Dependency Tracking via Descriptions

Dependencies between generated tasks are tracked through description annotations, keeping the task system simple:

```javascript
function buildTodoDescription(task, goal, dependencies) {
  let desc = task.description || '';

  if (task.estimatedHours) desc += `\n\nEstimated: ${task.estimatedHours}h`;
  if (task.category) desc += `\nCategory: ${task.category}`;
  if (dependencies.length > 0) desc += `\n\nDepends on: todos #${dependencies.join(', #')}`;

  desc += `\n\n[Part of goal: ${goal.title}]`;
  return desc.trim();
}
```

### Intelligent Due Date Distribution

Task due dates are calculated by distributing them across the available time before the goal's target date, with a 20% buffer:

```javascript
function calculateDueDate(goalTargetDate, task, position, totalTasks) {
  if (!goalTargetDate) return null;

  const target = new Date(goalTargetDate);
  const today = new Date();

  if (target < today) return today.toISOString().split('T')[0]; // Past due: all tasks due today

  const daysUntilDeadline = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  const effectiveDays = Math.floor(daysUntilDeadline * 0.8); // Leave 20% buffer

  const daysForTask = Math.ceil((effectiveDays / totalTasks) * (position + 1));
  const dueDate = new Date(today);
  dueDate.setDate(today.getDate() + daysForTask);

  return dueDate.toISOString().split('T')[0];
}
```

### Auto-Decomposition on Goal Creation

Goals that meet certain criteria are automatically decomposed when created, making them immediately actionable:

```javascript
async function autoDecomposeIfAppropriate(goalId) {
  const goal = await goals.getById(goalId);
  if (!goal) return null;

  // Only auto-decompose if:
  // 1. Goal has a target date (concrete timeline)
  // 2. Title is substantial (>15 chars, not just "fix bug")
  // 3. Goal hasn't been decomposed already
  // 4. No existing related tasks in the project
  if (!goal.targetDate) return null;
  if (goal.title.length < 15) return null;
  if (goal.description?.includes('Decomposed')) return null;

  if (goal.projectId) {
    const existing = await tasks.list({ projectId: goal.projectId, limit: 1 });
    if (existing.length > 0) return null;
  }

  return decomposeGoal(goalId, { maxTodos: 5 }); // Smaller initial decomposition
}
```

### Progress Tracking and Next Steps

The system can analyze todo completion status to report goal progress and suggest next actions:

```javascript
async function getNextSteps(goalId) {
  const goal = await goals.getById(goalId);
  const relatedTodos = await tasks.list({ projectId: goal.projectId, includeClosed: false });

  // Filter to tasks that reference this goal
  const goalTodos = relatedTodos.filter(
    (t) => t.description?.includes(goal.title) || t.description?.includes(`goal: ${goal.title}`)
  );

  const done = relatedTodos.filter((t) => t.status === 'done' && t.description?.includes(goal.title));
  const total = goalTodos.length + done.length;
  const progress = total > 0 ? Math.round((done.length / total) * 100) : 0;

  // Find next actionable tasks (pending with no unresolved dependencies)
  const actionable = goalTodos.filter((t) => {
    if (t.status !== 'pending') return false;
    const depMatch = t.description?.match(/Depends on: todos? #([\d, #]+)/i);
    if (!depMatch) return true;
    const depIds = depMatch[1].split(/,\s*#?/).map((id) => parseInt(id.replace('#', '')));
    return depIds.every((depId) => done.some((d) => d.id === depId));
  });

  return {
    goalId,
    progress,
    stats: { total, done: done.length, pending: goalTodos.length, blocked: /* ... */ },
    nextActionable: actionable.slice(0, 3).map((t) => ({ id: t.id, title: t.title })),
  };
}
```

### Goals as Documents

Goals are stored using the document-tasks system as documents with type `goal`, mapped through a compatibility layer:

```javascript
// lib/goals/store.js
async function create({ title, description, targetDate, periodType = 'weekly', projectId }) {
  const task = await tasksV2.create({
    title,
    description,
    type: tasksV2.TASK_TYPES.GOAL,
    dueDate: targetDate || null,
    documentId: projectId || null,
    properties: { periodType, progress: 0 },
  });

  return { id: task.id };
}

// Status mapping between goal language and task system
const statusToTaskStatus = { active: 'pending', completed: 'completed', abandoned: 'cancelled' };
const taskStatusToStatus = { pending: 'active', in_progress: 'active', completed: 'completed' };
```

### Similar Goal Discovery

Past goals help calibrate expectations for new ones:

```javascript
async function findSimilarGoals(goalTitle, limit = 5) {
  const keywords = goalTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const allGoals = [...(await goals.list({ status: 'completed', limit: 50 })),
                    ...(await goals.list({ status: 'active', limit: 50 }))];

  return allGoals
    .filter((g) => keywords.some((kw) => g.title.toLowerCase().includes(kw)))
    .sort((a, b) => (a.status === 'completed' ? -1 : 1)) // Completed goals first
    .slice(0, limit)
    .map((g) => ({
      title: g.title,
      status: g.status,
      daysToComplete: g.completedAt
        ? Math.ceil((new Date(g.completedAt) - new Date(g.createdAt)) / 86400000)
        : null,
    }));
}
```

## Implications

- Direct goal-to-todo decomposition (no intermediate objectives/strategies) keeps the system simple and produces immediately actionable output that integrates with the existing task system
- LLM-driven decomposition quality depends on prompt specificity -- generic goals produce generic tasks, so project context and codebase information significantly improve output
- Auto-decomposition triggers only for substantive goals with deadlines, preventing noise from quick goals like "remember to buy milk"
- Dependency tracking through description annotations is low-tech but effective -- it works with any task display system without schema changes
- Due date distribution with a 20% buffer accounts for the planning fallacy -- tasks aren't all due at the deadline
- The `suggestedOrder` from the LLM determines creation order, which also determines dependency resolution -- tasks created first can be referenced by later tasks
- Goals use the document-tasks system via a compatibility layer, which means goal queries benefit from the same indexing and filtering as regular tasks
- Progress tracking relies on description matching (`[Part of goal: ...]`), which is fragile if users edit task descriptions -- a foreign key relationship would be more robust but adds schema complexity
- Objectives module exists separately for measurable metrics (revenue, percentages) with snapshot tracking -- goals and objectives serve different purposes despite both being "things to achieve"

## Code Example

```javascript
const goals = require('./lib/goals');

// Create a goal
const { id: goalId } = await goals.create({
  title: 'Launch Riley mobile companion app',
  description: 'iOS app for quick interactions on the go',
  targetDate: '2024-06-01',
  projectId: 12,
});

// Decompose into actionable todos
const result = await goals.decomposition.decomposeGoal(goalId);
// → { analysis: 'This goal requires design, implementation, and app store submission...',
//    totalEstimatedHours: 120,
//    todosCreated: 7,
//    todos: [
//      { id: 201, title: 'Design mobile UI wireframes', estimatedHours: 16 },
//      { id: 202, title: 'Set up React Native project scaffold', estimatedHours: 8 },
//      ...
//    ] }

// Check progress later
const progress = await goals.decomposition.getNextSteps(goalId);
// → { progress: 28, stats: { total: 7, done: 2, pending: 4 },
//    nextActionable: [{ id: 204, title: 'Implement authentication flow' }] }

// Find similar past goals for estimation
const similar = await goals.decomposition.findSimilarGoals('mobile companion app');
// → [{ title: 'Build notification widget', status: 'completed', daysToComplete: 21 }]
```

## Related Patterns

- [Autonomous Agent Cycle](./autonomous-agent-cycle.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
