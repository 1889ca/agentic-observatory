# Unified Search Across Knowledge Bases

> Architecture for searching multiple project knowledge bases and memory simultaneously.

## Problem

<!-- TODO: Document the core friction -->
Knowledge is fragmented. Each project has its own KB, CC has auto-memory, Riley has her own store, and there's no way to search across all of them at once. Finding "that thing about ring buffers" means manually checking three or four different systems.

## Context

<!-- TODO: Expand with real scenarios -->
- Multiple projects registered with Riley, each with a KB
- CC auto-memory directories per project
- Riley's internal knowledge store
- Need for cross-cutting queries ("everything about authentication across all projects")

## Solution

<!-- TODO: Detail the pattern -->
- Search aggregation layer that fans out queries to multiple backends
- Normalized result format with source attribution
- Relevance ranking across heterogeneous sources
- Caching layer for repeated queries

## Implications

<!-- TODO: Analyze trade-offs -->
- Different KBs have different query capabilities (full-text vs. semantic vs. exact)
- Result ranking across different source types is non-trivial
- Latency is bounded by the slowest backend

## Code Example

```js
// TODO: Add search aggregation sketch
```

## Related Patterns

- [Activity Tracking Architecture](./activity-tracking-architecture.md)
