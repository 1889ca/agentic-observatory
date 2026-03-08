/**
 * Pattern registry — single source of truth for all patterns.
 * Add new patterns here; the homepage and pattern page read from this.
 */
const PATTERNS = [
  {
    slug: "satellite-permission-escalation",
    title: "Satellite Permission Escalation",
    summary: "Graceful handling of CC permission constraints in multi-agent delegated work.",
    status: "outline",
  },
  {
    slug: "activity-tracking-architecture",
    title: "Activity Tracking Architecture",
    summary: "Ring-buffer based activity tracking across distributed agent jobs.",
    status: "outline",
  },
  {
    slug: "flow-recovery-and-resilience",
    title: "Flow Recovery and Resilience",
    summary: "How to restart interrupted flows and maintain state consistency.",
    status: "outline",
  },
  {
    slug: "unified-search-across-kbs",
    title: "Unified Search Across KBs",
    summary: "Architecture for searching multiple project knowledge bases and memory simultaneously.",
    status: "outline",
  },
];
