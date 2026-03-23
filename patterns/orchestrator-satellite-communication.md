# Orchestrator-Worker Communication

> Dispatcher-driven task dispatch to on-demand Claude Code satellite processes, with DB-persisted task lifecycle, priority kanban queuing, and GitHub CC fallback when local dispatch fails.

## Problem

An orchestrator needs to dispatch heterogeneous work (code generation, issue solving, maintenance tasks) to AI agent workers, track execution through multiple terminal states, and synchronize results back to the originating documents. Simple "pending/running/done" state machines miss real-world outcomes like PR creation or task abandonment. Without execution history per document, there's no way to answer "how many times has this document been worked on, and what happened each time?"

## Context

- A central orchestrator dispatching work to Claude Code CLI processes spawned on demand
- Workers are not pre-registered — they are created when work needs to be done and destroyed when it completes
- A priority kanban queue governs dispatch ordering, not a real-time event bus
- GitHub CC (Claude Code) serves as a fallback executor when local dispatch fails
- Workers can produce multiple outcome types: successful completion, failure, PR creation, or voluntary abandonment
- Isolated execution contexts via git worktrees to prevent cross-task contamination

## Solution

### Architecture Overview

Task dispatch flows through a dispatcher module (`lib/worker/dispatcher.js`) that spawns Claude Code CLI processes with specific prompts and working directories. There is no Socket.io worker registry — workers are ephemeral processes, not persistent connections. The dispatcher manages a concurrency pool, tracks active workers, and routes incoming work through a priority kanban queue. Task state is DB-persisted with a full lifecycle state machine (pending -> dispatched -> running -> completed/failed/abandoned).

### Dispatcher-Based Worker Spawning

The dispatcher spawns Claude Code CLI processes on demand. Each worker is a standalone process with a defined prompt, model, and working directory. The dispatcher tracks active workers against a concurrency limit:

```javascript
// lib/worker/dispatcher.js (illustrative)
async function dispatch(task) {
  if (activeWorkers.size >= maxConcurrency) {
    queue.enqueue(task);  // Back-pressure into the kanban queue
    return;
  }

  await db.query(
    `UPDATE tasks SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`,
    [task.id]
  );

  const worktree = await prepareWorktree(task.project);
  const worker = spawn('claude', [
    '--prompt', task.prompt,
    '--model', task.model || 'sonnet',
    '--cwd', worktree.path,
  ]);

  activeWorkers.set(task.id, { process: worker, worktree, startedAt: Date.now() });

  worker.on('exit', (code) => handleWorkerExit(task.id, code));
}
```

### Worktree Isolation

Each dispatched task gets its own git worktree to prevent cross-task contamination. When two tasks target the same repository, they operate on independent working copies:

```javascript
// lib/worker/worktree.js (illustrative)
async function prepareWorktree(project) {
  const worktreePath = path.join(WORKTREES_DIR, `${project}-${Date.now()}`);
  await exec(`git worktree add ${worktreePath} -b work/${project}-${Date.now()}`);
  return { path: worktreePath, cleanup: () => exec(`git worktree remove ${worktreePath}`) };
}
```

### Priority Kanban Queue

Work enters the system through a kanban queue that respects priority lanes. The dispatcher pulls from this queue whenever a worker slot opens up:

```
Task created → kanban queue (prioritized) → dispatcher picks up → CC process spawned → process exits → result captured
```

Higher-priority lanes (e.g., urgent fixes) are drained before lower-priority ones (e.g., routine maintenance). The queue is the single entry point for all work — scheduled tasks, manual triggers, and agent-initiated work all flow through it.

### Completion via Process Exit

Results come back when the Claude Code process exits, not via event callbacks. The dispatcher inspects the exit code and any artifacts (commits, PRs) produced during execution:

```javascript
// lib/worker/dispatcher.js (illustrative)
async function handleWorkerExit(taskId, exitCode) {
  const worker = activeWorkers.get(taskId);
  activeWorkers.delete(taskId);

  const status = exitCode === 0 ? 'completed' : 'failed';
  await db.query(
    `UPDATE tasks SET status = $1, completed_at = NOW(), exit_code = $2 WHERE id = $3`,
    [status, exitCode, taskId]
  );

  // Clean up the worktree
  await worker.worktree.cleanup();

  // Pull next task from the queue if one is waiting
  const next = queue.dequeue();
  if (next) await dispatch(next);
}
```

### GitHub CC Fallback

When local dispatch fails (e.g., CLI not available, system resource exhaustion), the dispatcher can fall back to GitHub-hosted Claude Code. This is a safety net, not the primary execution path:

```javascript
// lib/worker/fallback.js (illustrative)
async function dispatchToGitHub(task) {
  // Trigger a GitHub Actions workflow that runs CC in the cloud
  await octokit.actions.createWorkflowDispatch({
    owner, repo,
    workflow_id: 'cc-task.yml',
    inputs: { prompt: task.prompt, taskId: task.id },
  });
}
```

## Implications

- Workers are stateless, ephemeral processes — there is no registry to maintain, no heartbeats to monitor, and no reconnection logic to handle
- The kanban queue is the single choke point for all work dispatch, making it easy to observe system load and enforce back-pressure
- DB-persisted task state (with proper locking) is the source of truth, surviving restarts and enabling the orchestrator to resume in-flight work
- Git worktree isolation means concurrent tasks on the same repo do not conflict, but worktree cleanup is critical to avoid disk exhaustion
- The GitHub CC fallback ensures no task is permanently stranded, but it is slower and less observable than local dispatch — it should be treated as a safety net
- The full lifecycle state machine (pending -> dispatched -> running -> completed/failed/abandoned) provides richer observability than a simple pending/done model
- Concurrency limits in the dispatcher prevent resource exhaustion — the queue absorbs overflow naturally

## Code Example

```javascript
// Full lifecycle: task created, queued, dispatched, worker exits, result persisted

// --- Task enters the system ---
const task = await createTask({
  id: 'task-42',
  type: 'solve-issue',
  prompt: 'Fix the pagination bug in /api/users. See issue #99.',
  project: 'billing-api',
  model: 'sonnet',
  priority: 'high',
});

// --- Kanban queue orders by priority ---
// queue: [task-42 (high), task-38 (normal), task-35 (low)]

// --- Dispatcher picks up task-42 when a slot is available ---
// 1. Prepares a git worktree for billing-api
// 2. Spawns: claude --prompt "Fix the pagination bug..." --model sonnet --cwd /worktrees/billing-api-1234
// 3. Tracks the process in activeWorkers

// --- CC process runs, makes commits, opens a PR, exits with code 0 ---

// --- Dispatcher handles exit ---
// 1. Updates DB: status = 'completed', exit_code = 0
// 2. Cleans up the worktree
// 3. Pulls task-38 from the queue and dispatches it

// --- If local dispatch had failed ---
// dispatchToGitHub(task) triggers a GitHub Actions workflow as fallback
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
