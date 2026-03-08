# Flow Recovery and Resilience

> How to restart interrupted flows and maintain state consistency.

## Problem

<!-- TODO: Document the core friction -->
Flows break. Satellites crash, context windows fill up, permissions block, network drops. When a multi-step flow fails partway through, the orchestrator needs to know what completed, what didn't, and how to resume without re-doing finished work or corrupting state.

## Context

<!-- TODO: Expand with real scenarios -->
- Multi-step flows dispatched by Riley
- Steps that have side effects (commits, API calls, file writes)
- Long-running operations that exceed CC session limits
- Concurrent flows that share resources

## Solution

<!-- TODO: Detail the pattern -->
- Step-level completion tracking with checkpoints
- Idempotent step design where possible
- State snapshots between steps for resume points
- Orchestrator-level retry logic with backoff
- Dead letter queue for permanently failed steps

## Implications

<!-- TODO: Analyze trade-offs -->
- Idempotency isn't free — requires careful step design
- Checkpoint storage adds overhead
- Resume logic must handle partial side effects from failed steps

## Code Example

```js
// TODO: Add flow checkpoint/resume sketch
```

## Related Patterns

- [Satellite Permission Escalation](./satellite-permission-escalation.md)
- [Activity Tracking Architecture](./activity-tracking-architecture.md)
