# Satellite Permission Escalation

> Graceful handling of Claude Code permission constraints in multi-agent delegated work.

## Problem

When an orchestrator dispatches work to CC satellite instances, those satellites hit interactive permission prompts that block automated execution. From the orchestrator's perspective, a permission denial is indistinguishable from a crash or timeout — the satellite simply stops producing output. This creates a class of silent failures where the orchestrator retries work that can never succeed, wastes satellite slots, and has no diagnostic signal to inform alternative strategies.

## Context

- Multi-agent flows where an orchestrator spawns CC instances via a satellite worker daemon
- Satellites running with varying permission modes (auto-accept, selective, manual)
- Long-running tasks that span multiple tool categories (file reads, writes, bash, network)
- Flow steps that require different permission profiles than the satellite was configured with

## Solution

**Permission Profile Declaration:** Flow definitions declare expected tool categories per step. Before dispatching, the orchestrator validates that the target satellite's permission mode covers the required tools.

```yaml
# .riley/capabilities.yaml — flow with permission hints
flows:
  code-review:
    steps:
      - prompt: "Read and analyze the PR changes"
        permissions: [read, grep, glob]
      - prompt: "Apply suggested fixes"
        permissions: [read, edit, write, bash]
```

**Satellite Configuration Isolation:** Each project can specify a dedicated Claude Code config directory via its capabilities manifest, ensuring satellites run with project-appropriate permission settings.

```javascript
// capabilities.yaml — per-project CLI config
cli:
  env:
    CLAUDE_CONFIG_DIR: "/path/to/project/.claude-satellite"
```

**Structured Failure Reporting:** Satellites communicate via a newline-delimited JSON protocol. When a satellite stalls (no output for extended period), the orchestrator can distinguish between:
- Active work (satellite is processing)
- Permission block (satellite is waiting for user input)
- Crash (process exited with non-zero code)

The satellite worker tracks byte count and last-activity timestamps per job, enabling the watchdog to detect stalls.

**Watchdog Detection:** A recovery loop runs every 60 seconds, checking for stale steps:
- Steps running >50 minutes: marked as error, job cancelled
- Steps with no active child process: retried from scratch
- Steps <2 minutes old with no activity: given grace period (may still be starting)

**Fallback Strategies:**
1. Retry with a more permissive satellite configuration
2. Break the step into smaller sub-steps requiring fewer permissions
3. Escalate to the orchestrator queue for human-in-the-loop resolution
4. Skip the step and continue the flow if marked as optional

## Implications

- Flow definitions must declare expected tool usage upfront, adding authoring overhead
- Per-project satellite configs increase configuration surface area
- Watchdog detection has inherent latency (60s polling interval)
- No way to programmatically grant permissions mid-session — blocked satellites must be restarted
- The 50-minute hard timeout means very long operations need chunking

## Code Example

```javascript
// Satellite worker job tracking — actual protocol
// Request:
{ type: 'run', id: jobId, prompt, cwd, config_dir, model }

// Streaming response:
{ id, status: 'started' }
{ id, chunk: 'Working on...', stderr: false }
{ id, output: 'Final result', exit_code: 0, done: true, logPath }

// Status query for stall detection:
{ type: 'status' }
// Returns: { jobs: [{ id, cwd, pid, logPath, byteCount }], max }
```

## Related Patterns

- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
