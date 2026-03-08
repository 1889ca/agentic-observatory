# Activity Tracking Architecture

> Ring-buffer based activity tracking across distributed agent jobs.

## Problem

<!-- TODO: Document the core friction -->
With multiple CC satellites running concurrently, there's no unified view of what's happening. Activity data is scattered across individual session logs, making it impossible to answer "what are my agents doing right now?" or "what happened in the last hour?"

## Context

<!-- TODO: Expand with real scenarios -->
- Riley orchestrating multiple concurrent CC instances
- Need for real-time dashboard of agent activity
- Historical queries over recent activity windows
- Memory-bounded — can't store everything forever

## Solution

<!-- TODO: Detail the pattern -->
- Fixed-size ring buffer per satellite for recent activity
- Aggregation layer that merges satellite buffers into unified timeline
- Time-windowed queries (last N minutes, last N events)
- Structured activity events with consistent schema

## Implications

<!-- TODO: Analyze trade-offs -->
- Ring buffer means old data drops off — acceptable for "what's happening now"
- Schema enforcement needed across all satellites
- Aggregation has inherent latency

## Code Example

```js
// TODO: Add ring buffer implementation sketch
```

## Related Patterns

- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
