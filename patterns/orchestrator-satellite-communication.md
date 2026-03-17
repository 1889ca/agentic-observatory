# Orchestrator-Satellite Communication

> DB-backed task queue with subprocess spawning for orchestrator-to-satellite job dispatch, status tracking, and result collection.

## Problem

An orchestrator needs to dispatch work to AI agent instances, track their progress, detect failures, and collect results. Direct inter-process communication (sockets, pipes) couples the orchestrator tightly to worker lifecycle — if a worker crashes mid-stream, the connection is lost and so is any partial output. What's needed is a durable dispatch mechanism where work survives process restarts, results persist regardless of worker fate, and concurrency is controlled without custom protocol logic.

## Context

- One orchestrator process managing N satellite workers on the same machine
- Jobs run as Claude Code CLI subprocesses that produce text output
- Need for concurrent job limits, cancellation, and crash recovery
- Workers may crash or be killed without warning
- Job state must survive orchestrator restarts — no in-memory-only queues
- Multiple components (API, scheduler, kanban worker) submit jobs to the same pipeline

## Solution

### DB-Backed Task Queue

Instead of dispatching jobs directly to workers over a socket or RPC channel, the orchestrator writes task records to a database table. Workers poll this table for pending work. This decouples submission from execution entirely — the API, scheduler, and manual triggers all write to the same table, and the kanban worker picks them up uniformly:

```javascript
// db/tasks.js
async function enqueueTask({ prompt, workdir, model, priority, source }) {
  return db('tasks').insert({
    id: generateId(),
    prompt,
    workdir,
    model: model || 'sonnet',
    priority: priority || 'normal',
    source,
    status: 'pending',
    created_at: new Date(),
  }).returning('*');
}

async function claimNextTask() {
  // Atomic claim: update the first pending task to 'running' and return it
  // DB-level locking prevents two workers from claiming the same task
  return db('tasks')
    .where({ status: 'pending' })
    .orderByRaw("CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'operational' THEN 3 END")
    .orderBy('created_at', 'asc')
    .first()
    .update({ status: 'running', started_at: new Date() })
    .returning('*');
}
```

### Task State Machine

Every task moves through a fixed set of states. The state column in the database is the single source of truth — no in-memory state needs to agree with it:

```
pending → running → completed
                  → failed
```

```javascript
// db/tasks.js
async function completeTask(taskId, output, exitCode) {
  return db('tasks')
    .where({ id: taskId })
    .update({
      status: exitCode === 0 ? 'completed' : 'failed',
      output,
      exit_code: exitCode,
      completed_at: new Date(),
    });
}
```

### Kanban Worker

The kanban worker is a polling loop that claims pending tasks from the DB and spawns Claude Code subprocesses to execute them. It ticks on a short interval, checking for available work and available capacity:

```javascript
// kanban-worker.js
const MAX_CONCURRENT = parseInt(process.env.MAX_WORKERS || '4');
const activeJobs = new Map();

async function tick() {
  if (activeJobs.size >= MAX_CONCURRENT) return;

  const task = await claimNextTask();
  if (!task) return;

  const proc = spawnSatellite(task);
  activeJobs.set(task.id, { proc, task, startedAt: Date.now() });

  proc.on('exit', async (code) => {
    activeJobs.delete(task.id);
    await completeTask(task.id, proc.collectedOutput, code);
  });
}

setInterval(tick, TICK_INTERVAL_MS);
```

### Subprocess Spawning

Each task is executed by spawning the Claude Code CLI as a child process. The orchestrator captures stdout for the result and monitors the exit code for success or failure:

```javascript
// kanban-worker.js
function spawnSatellite(task) {
  const args = [
    '--print', task.prompt,
    '--model', task.model,
    '--output-format', 'text',
  ];

  const proc = spawn('claude', args, {
    cwd: task.workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_HEADLESS: '1' },
  });

  // Collect output from stdout
  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });

  proc.stderr.on('data', (data) => {
    logger.warn({ taskId: task.id }, data.toString());
  });

  proc.collectedOutput = '';
  Object.defineProperty(proc, 'collectedOutput', {
    get: () => output,
  });

  return proc;
}
```

### Exit Code Monitoring

The orchestrator determines task success or failure purely from the subprocess exit code. This keeps the protocol dead simple — no custom status messages, no heartbeat protocol, no acknowledgement frames:

```javascript
proc.on('exit', async (code) => {
  const duration = (Date.now() - startedAt) / 1000;

  if (code === 0) {
    logger.info({ taskId: task.id, duration }, 'Task completed');
    await completeTask(task.id, proc.collectedOutput, 0);
  } else {
    logger.error({ taskId: task.id, exitCode: code, duration }, 'Task failed');
    await completeTask(task.id, proc.collectedOutput, code);

    // Retry logic for transient failures
    if (task.retries < MAX_RETRIES) {
      await requeueTask(task.id, task.retries + 1);
    }
  }

  activeJobs.delete(task.id);
});
```

### Stale Task Recovery

If the orchestrator crashes while tasks are in the `running` state, those tasks are orphaned. On startup, a sweep marks any `running` tasks that have no live subprocess as `pending` again:

```javascript
// startup.js
async function recoverStaleTasks() {
  const stale = await db('tasks')
    .where({ status: 'running' })
    .where('started_at', '<', new Date(Date.now() - STALE_THRESHOLD_MS));

  for (const task of stale) {
    logger.warn({ taskId: task.id }, 'Recovering stale task — requeueing');
    await db('tasks')
      .where({ id: task.id })
      .update({ status: 'pending', started_at: null });
  }
}
```

## Implications

- The DB is the single source of truth for task state — no reconciliation needed between in-memory and persistent state
- Subprocess spawning is simpler than maintaining a socket protocol — the OS handles process lifecycle, signal delivery, and resource cleanup
- Exit codes are a universal success/failure signal — no custom error encoding required
- DB-level atomic claims (update-returning) prevent two workers from grabbing the same task, replacing the need for a custom locking protocol
- Task records survive orchestrator restarts, unlike in-memory queues or socket connections
- Output is only captured at completion, not streamed — this trades real-time visibility for implementation simplicity
- Polling introduces latency (up to one tick interval) between task submission and pickup, which is acceptable for jobs measured in minutes
- The stale task recovery sweep means no task is silently lost, even after an unclean shutdown
- Concurrency control lives in the kanban worker's `MAX_CONCURRENT` check — the DB doesn't enforce it, so running multiple kanban workers requires the distributed job locking pattern

## Code Example

```javascript
// Complete dispatch cycle: submit task → DB queue → kanban pickup → subprocess → result
async function dispatchAndWait(prompt, workdir, model) {
  // 1. Enqueue to DB
  const [task] = await enqueueTask({
    prompt,
    workdir,
    model: model || 'sonnet',
    priority: 'normal',
    source: 'api',
  });

  // 2. Poll for completion (kanban worker picks it up independently)
  const result = await pollForCompletion(task.id, {
    interval: 5000,
    timeout: 30 * 60 * 1000,
  });

  return {
    success: result.status === 'completed',
    output: result.output,
    exit_code: result.exit_code,
    duration: (result.completed_at - result.started_at) / 1000,
  };
}

async function pollForCompletion(taskId, { interval, timeout }) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const task = await db('tasks').where({ id: taskId }).first();

    if (task.status === 'completed' || task.status === 'failed') {
      return task;
    }

    await sleep(interval);
  }

  throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
}
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Worker Dispatcher and Priority Queue](./worker-dispatcher-and-priority-queue.md)
- [Distributed Job Locking](./distributed-job-locking.md)
