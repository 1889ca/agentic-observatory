# Satellite Permission Escalation

> Graceful handling of Claude Code permission constraints in multi-agent delegated work.

## Problem

<!-- TODO: Document the core friction -->
When Riley dispatches work to CC satellites, those satellites hit permission prompts that block automated flow execution. The orchestrator has no visibility into _why_ a satellite stalled — permission denial looks identical to a crash or timeout from the outside.

## Context

<!-- TODO: Expand with real scenarios -->
- Multi-agent flows where Riley spawns CC instances to do work
- Satellites running with various permission modes (auto-accept, selective, manual)
- Long-running tasks that span multiple tool categories

## Solution

<!-- TODO: Detail the pattern -->
- Pre-flight permission checks before dispatching work
- Permission profile declarations in flow definitions
- Fallback strategies when escalation is denied
- Reporting mechanism so orchestrator knows _what_ was denied, not just that work stopped

## Implications

<!-- TODO: Analyze trade-offs -->
- Requires flow definitions to declare expected tool usage upfront
- Satellites need a standardized "I got blocked" report format
- May limit flexibility of what satellites can do dynamically

## Code Example

```js
// TODO: Add minimal example of permission-aware flow dispatch
```

## Related Patterns

- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
