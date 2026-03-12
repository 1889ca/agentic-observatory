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
  {
    slug: "declarative-capability-system",
    title: "Declarative Capability System",
    summary: "Four-tier capability model (tools, skills, reflexes, workflows) with JSON Schema declarations for LLM-native tool use.",
    status: "published",
  },
  {
    slug: "evolution-and-self-improvement",
    title: "Evolution and Self-Improvement",
    summary: "Observe-analyze-propose-apply cycle for autonomous system improvement from operational data.",
    status: "published",
  },
  {
    slug: "unified-event-system",
    title: "Unified Event System",
    summary: "Dual-mode event bus with debounced entity events and immediate system events for reactive UI.",
    status: "published",
  },
  {
    slug: "message-processing-pipeline",
    title: "Message Processing Pipeline",
    summary: "End-to-end flow from user input through context assembly, LLM dispatch, tool loop, and response delivery.",
    status: "published",
  },
  {
    slug: "error-triage-and-recovery",
    title: "Error Triage and Recovery",
    summary: "Categorize failures into protocol, transient, and runtime classes with distinct recovery strategies.",
    status: "published",
  },
  {
    slug: "intent-driven-self-scheduling",
    title: "Intent-Driven Self-Scheduling",
    summary: "An agent schedules its own future wake-ups rather than relying on external polling or fixed cron intervals.",
    status: "published",
  },
  {
    slug: "inner-monologue-and-reflection",
    title: "Inner Monologue and Reflection",
    summary: "Private reflection cycle where an agent thinks without broadcasting, deciding what to surface and what to resolve internally.",
    status: "published",
  },
  {
    slug: "decision-gating-and-autonomy-tiers",
    title: "Decision Gating and Autonomy Tiers",
    summary: "Route autonomous agent decisions through notification tiers to prevent alert fatigue while ensuring critical actions reach humans.",
    status: "published",
  },
  {
    slug: "narrative-memory-generation",
    title: "Narrative Memory Generation",
    summary: "Convert structured operational data into story-form memories with semantic valence for richer retrieval and learning.",
    status: "published",
  },
  {
    slug: "domain-aware-memory-scoring",
    title: "Domain-Aware Memory Scoring",
    summary: "Score memory relevance using domain-specific thresholds and recency decay rather than raw similarity alone.",
    status: "published",
  },
  {
    slug: "plugin-system-and-hot-reload",
    title: "Plugin System and Hot-Reload",
    summary: "Extensible plugin architecture with file watching, context building, and graceful lifecycle management.",
    status: "published",
  },
  {
    slug: "skill-extraction-and-fast-path-routing",
    title: "Skill Extraction and Fast-Path Routing",
    summary: "Embeddings-based semantic skill matching with learned reflex promotion for progressively faster dispatch.",
    status: "published",
  },
  {
    slug: "autonomous-agent-cycle",
    title: "Autonomous Agent Cycle",
    summary: "Priority-driven action cycle with working hours, autonomy tiers, and batch approval for self-directed agent behavior.",
    status: "published",
  },
  {
    slug: "dynamic-system-prompt-composition",
    title: "Dynamic System Prompt Composition",
    summary: "Runtime assembly of system prompts from persona, capabilities, behavioral rules, and contextual signals.",
    status: "published",
  },
];
