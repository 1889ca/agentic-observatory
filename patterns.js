/**
 * Pattern registry — single source of truth for all patterns.
 * Add new patterns here; the homepage and pattern page read from this.
 */
const PATTERNS = [
  {
    slug: "orchestrator-satellite-communication",
    title: "Orchestrator-Satellite Communication",
    summary: "Structured protocol for reliable communication between an orchestrator and its worker agents.",
    status: "published",
  },
  {
    slug: "satellite-permission-escalation",
    title: "Satellite Permission Escalation",
    summary: "Graceful handling of CC permission constraints in multi-agent delegated work.",
    status: "published",
  },
  {
    slug: "flow-recovery-and-resilience",
    title: "Flow Recovery and Resilience",
    summary: "How to restart interrupted flows and maintain state consistency across orchestrator restarts.",
    status: "published",
  },
  {
    slug: "activity-tracking-architecture",
    title: "Activity Tracking Architecture",
    summary: "Multi-layered activity tracking across distributed agent jobs with audit trails and real-time monitoring.",
    status: "published",
  },
  {
    slug: "unified-search-across-kbs",
    title: "Unified Search Across KBs",
    summary: "Architecture for searching multiple project knowledge bases and memory simultaneously.",
    status: "published",
  },
  {
    slug: "multi-model-deliberation",
    title: "Multi-Model Deliberation",
    summary: "Combining multiple AI models for higher-confidence decisions through structured debate.",
    status: "published",
  },
  {
    slug: "scheduled-autonomous-maintenance",
    title: "Scheduled Autonomous Maintenance",
    summary: "Self-managing projects through cron-scheduled satellite tasks with orchestrator oversight.",
    status: "published",
  },
  {
    slug: "session-consolidation-and-memory",
    title: "Session Consolidation and Memory",
    summary: "Periodic summarization and narrative storage to maintain continuity across AI sessions.",
    status: "published",
  },
  {
    slug: "context-assembly-pipeline",
    title: "Context Assembly Pipeline",
    summary: "Budget-aware assembly of multi-source context for each AI dispatch, tuned by dispatch type.",
    status: "published",
  },
  {
    slug: "gateway-brain-split",
    title: "Gateway-Brain Split",
    summary: "Process isolation between the web-facing gateway and the AI brain for graceful degradation.",
    status: "published",
  },
  {
    slug: "capability-manifest-registration",
    title: "Capability Manifest Registration",
    summary: "Pluggable project registration via declarative manifests for orchestrator capability discovery.",
    status: "published",
  },
];
