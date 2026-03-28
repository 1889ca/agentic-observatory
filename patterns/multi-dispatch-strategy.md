# Multi-Dispatch Strategy

> A weighted-priority dispatcher that collects work from multiple sources (`work-sources.js`), scores candidates, and routes them through runner-based or async execution paths while enforcing repo-level concurrency locks.

## Problem

Not all tasks have the same execution requirements. Some need immediate results — a user-requested coding task that must start running right away. Others are background work discovered by scanning GitHub issues or project health. The dispatcher must collect work from diverse sources, rank it fairly, and route it to the right execution path — all while preventing two workers from clobbering the same repository simultaneously.

## Context

- A dispatcher that receives work from multiple sources: user requests, retryable failed tasks, GitHub issues, coding todos, and project health scans
- Tasks vary in urgency, source, and whether a persistent worker process is available
- Worker availability is bounded by `MAX_PARALLEL_WORKERS` (default 3)
- A single repository should not have two concurrent workers to avoid git conflicts
- All tasks share a common DB record structure (`worker_tasks` table) regardless of execution path
- The system uses Claude Code satellites as worker processes

## Solution

### Work Source Collection

The `work-sources.js` module identifies dispatchable work from five sources. Each source returns candidates with metadata that feeds into scoring:

```javascript
// lib/worker/work-sources.js
// Sources (not "identify-work.js"):

// 1. User requests — tasks manually dispatched via the UI or API
async function getPendingUserTasks() { /* query worker_tasks WHERE status = 'pending' */ }

// 2. Retryable failures — tasks that failed but have attempts remaining
async function getRetryableTasks() {
  return raw(`
    SELECT * FROM worker_tasks
    WHERE status = 'attempt_failed'
      AND attempt_count < 3
      AND last_activity < NOW() - INTERVAL '30 minutes'
    ORDER BY created_at ASC LIMIT 5
  `)
}

// 3. GitHub issues with worker-ready labels
async function getWorkerReadyIssues() { /* issues labeled for automated work */ }

// 4. Solvable GitHub issues (scored by heuristic)
async function getSolvableIssues() { /* scored by labels, title keywords, age */ }

// 5. Coding-related todos from the document system
async function getCodingTodos() { /* todos matching coding keyword patterns */ }
```

The solvability scorer uses a heuristic that boosts issues labeled `bug`, `good-first-issue`, or `help-wanted`, and penalizes `refactor`, `redesign`, or `breaking` changes.

### Weighted Priority Scoring

The dispatcher (`lib/worker/dispatcher.js`) assigns each candidate a score combining source weight and item-specific scoring:

```javascript
// lib/worker/dispatcher.js
const SOURCE_WEIGHTS = {
  user_request:       90,
  retry_failed:       80,
  github_issue_ready: 70,
  coding_todo:        50,
  github_issue:       40,
  health_check:       30,
}

async function identifyWork() {
  const running = await workerTasks.getRunning()
  if (running.length >= MAX_PARALLEL_WORKERS) return []

  const work = []
  const sources = [
    { fn: getPendingUserTasks,  source: 'user_request',       scoreBase: 90, scoreFn: (t) => t.priority || 0 },
    { fn: getRetryableTasks,    source: 'retry_failed',       scoreBase: 80, scoreFn: (t) => -(t.attempt_count || 0) * 10 },
    { fn: getWorkerReadyIssues, source: 'github_issue_ready', scoreBase: 70, scoreFn: () => 0 },
    { fn: getSolvableIssues,    source: 'github_issue',       scoreBase: 40, scoreFn: (i) => i.solvabilityScore * 2 },
    { fn: getCodingTodos,       source: 'coding_todo',        scoreBase: 50, scoreFn: (t) => priorityBonus(t) },
  ]

  for (const src of sources) {
    const items = await src.fn()
    for (const item of items) {
      work.push({
        source: src.source,
        item,
        score: src.scoreBase + src.scoreFn(item),
        estimatedCost: src.cost,
      })
    }
  }

  return work.sort((a, b) => b.score - a.score)
}
```

User requests always win (base 90), followed by retries (80) and labeled issues (70). Within each tier, item-specific scoring provides finer ordering.

### Repo-Level Concurrency Lock

Before dispatching, the dispatcher checks which repositories already have running workers. Any candidate targeting a repo with active work is filtered out:

```javascript
// lib/worker/dispatcher.js
const runningRepos = new Set()
for (const task of running) {
  const params = typeof task.params === 'string' ? JSON.parse(task.params) : task.params
  const repo = params?.owner && params?.repo ? `${params.owner}/${params.repo}` : params?.repo
  if (repo) runningRepos.add(repo)
}

const filteredWork = work.filter((item) => {
  const repo = extractRepo(item)
  if (repo && runningRepos.has(repo)) return false
  return true
})
```

A separate `repo-lock.js` module provides `canWorkOnRepo()`, `registerRepoWork()`, and `unregisterRepoWork()` for formal lock management.

### Dispatch Routing

The dispatcher module (`dispatch.js`) routes tasks to typed workers based on task type and worker availability. Task types are normalized to handle LLM-hallucinated types:

```javascript
// lib/worker/dispatch.js
const VALID_TASK_TYPES = new Set([
  'solve-issue', 'ask-codebase', 'run-command', 'git-operation',
  'self-improve', 'headless-gemini', 'doctl', 'coding', 'code-review',
])

function normalizeTaskType(taskType) {
  if (!taskType) return 'coding'
  const normalized = taskType.toLowerCase().replace(/_/g, '-')
  if (VALID_TASK_TYPES.has(normalized)) return normalized
  return 'coding'  // Unknown types run through the general-purpose runner
}

async function dispatchToWorker(task, workerType = null) {
  const effectiveWorkerType = workerType || workerTypes.findWorkerTypeForTask(task.taskType)
  const effectiveTaskType = normalizeTaskType(task.taskType)

  const taskRecord = await workerTasks.create({
    taskType: effectiveTaskType,
    workerType: effectiveWorkerType,
    description: task.description,
    params: task.params || {},
    priority: task.priority || 0,
    dedupeKey: task.dedupeKey,
  })

  // Notify connected worker via Socket.io
  const available = findAvailableWorker(effectiveWorkerType)
  if (available) {
    notifyWorkerOfTask(available.id, taskRecord)
  }

  return { success: true, taskId: taskRecord.task_id, queued: !available }
}
```

### Execution Paths

Three execution modules handle the actual work:

- **`dispatch-runners.js`** — Creates task records and kicks off async execution for each source type. Handles document linking, worker execution initialization, and source-specific setup.
- **`dispatch-async.js`** — Contains the async execution functions that actually run tasks (code review, issue solving, etc.) using Claude Code satellites.
- **`dispatch.js`** — Routes tasks to typed workers and handles socket-based notification when workers are connected.

Worker notification uses Socket.io:

```javascript
// lib/worker/dispatch.js
function notifyWorkerOfTask(workerId, task) {
  const worker = state.getWorker(workerId)
  if (!worker?.socket) return

  worker.socket.emit('task:available', {
    taskId: task.task_id,
    taskType: task.task_type,
    workerType: task.worker_type,
    description: task.description,
    priority: task.priority || 0,
  })
}
```

### Health-Based Work Discovery

The dispatcher also checks project health via `health-scanner.js`, which scans tracked projects for failing CI runs, stale PRs, and security advisories. Health issues enter the work queue at priority 30 (lowest tier):

```javascript
// lib/worker/dispatcher.js
const healthIssues = await healthScanner.scanAllProjects()
for (const issue of healthIssues.slice(0, 3)) {
  work.push({
    source: 'health_check',
    item: issue,
    score: SOURCE_WEIGHTS.health_check + issue.score,
    estimatedCost: issue.type === 'ci_failure' ? 20 : 15,
  })
}
```

## Implications

- Weighted scoring creates a clear priority hierarchy (user > retry > issue > todo > health) while allowing individual item quality to influence ordering within tiers
- Repo-level locking prevents git conflicts but means a busy repository blocks all other work on that repo until the current task completes
- Task type normalization handles the reality that LLMs hallucinate task types — `bug_investigation` becomes `coding` rather than failing
- Source-specific limits (e.g., max 3 GitHub issues per cycle) prevent any single source from monopolizing worker capacity
- The dispatcher runs on a periodic tick — it does not respond to individual task creation events. This creates bounded dispatch cycles but introduces latency between task creation and execution.
- `MAX_PARALLEL_WORKERS` is a hard cap that prevents cost overruns but means excess work queues until a slot opens
- Error handling is per-source — one source failing does not prevent other sources from contributing work

## Code Example

```javascript
// The dispatch cycle (called periodically)
async function dispatchCycle() {
  const candidates = await identifyWork()
  if (candidates.length === 0) return

  const budget = await ccUsage.getRemainingBudget()
  if (!budget.available) return

  for (const candidate of candidates.slice(0, MAX_PARALLEL_WORKERS)) {
    // Source-specific dispatch via dispatch-runners.js
    switch (candidate.source) {
      case 'user_request':
        await dispatchUserRequest(candidate.item)
        break
      case 'coding_todo':
        await dispatchCodingTodo(candidate.item)
        break
      case 'github_issue':
        await dispatchGitHubIssue(candidate.item)
        break
      case 'retry_failed':
        await dispatchRetry(candidate.item)
        break
      case 'health_check':
        await dispatchHealthFix(candidate.item)
        break
    }
  }
}
```

## Related Patterns

- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
- [Task Lifecycle and State Machine](./task-lifecycle-and-state-machine.md)
