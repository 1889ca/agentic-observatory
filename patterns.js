/**
 * Pattern registry — single source of truth for all patterns.
 * Add new patterns here; the homepage and pattern page read from this.
 */
const PATTERNS = [
  {
    slug: "orchestrator-satellite-communication",
    title: "Orchestrator-Satellite Communication",
    summary: "Structured protocol for reliable communication between an orchestrator and its worker agents.",
    status: "draft",
  },
  {
    slug: "satellite-permission-escalation",
    title: "Satellite Permission Escalation",
    summary: "Graceful handling of CC permission constraints in multi-agent delegated work.",
    status: "draft",
  },
  {
    slug: "flow-recovery-and-resilience",
    title: "Flow Recovery and Resilience",
    summary: "How to restart interrupted flows and maintain state consistency across orchestrator restarts.",
    status: "draft",
  },
  {
    slug: "activity-tracking-architecture",
    title: "Activity Tracking Architecture",
    summary: "Multi-layered activity tracking across distributed agent jobs with audit trails and real-time monitoring.",
    status: "draft",
  },
  {
    slug: "unified-search-across-kbs",
    title: "Unified Search Across KBs",
    summary: "Architecture for searching multiple project knowledge bases and memory simultaneously.",
    status: "draft",
  },
  {
    slug: "multi-model-deliberation",
    title: "Multi-Model Deliberation",
    summary: "Combining multiple AI models for higher-confidence decisions through structured debate.",
    status: "draft",
  },
  {
    slug: "scheduled-autonomous-maintenance",
    title: "Scheduled Autonomous Maintenance",
    summary: "Self-managing projects through cron-scheduled satellite tasks with orchestrator oversight.",
    status: "draft",
  },
];
