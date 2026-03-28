# Skill Extraction and Fast-Path Routing

> Markdown-based skill files with YAML frontmatter for metadata, embedding-based vector similarity matching for fast-path dispatch, and a reflex promotion pipeline that can bypass LLM composition entirely for high-confidence patterns.

## Problem

An LLM orchestrator processes every incoming message through the same pipeline: full context assembly, tool declaration injection, and multi-turn LLM dispatch. But many messages are repetitive — "check the deploy status", "summarize today's activity", "approve task #42". Running a full LLM cycle for well-known operations wastes tokens and adds latency. The system should recognize common patterns and shortcut them.

## Context

- An orchestrator handling a mix of novel and repetitive user requests
- Skills defined as `.md` files with YAML frontmatter metadata (not `.yml` files)
- A dual matching system: trigger-based keyword matching for file-based skills and embedding-based vector similarity for database-stored skills
- Need to balance speed (fast-path) with accuracy (no false shortcuts)
- The system should be extensible — adding a new skill means adding a file or extracting one from repeated patterns

## Solution

### File-Based Skill Discovery

Skills are `.md` files (specifically `SKILL.md` or `*.skill.md`) with YAML frontmatter. The system scans multiple directories with a priority hierarchy: builtin < plugin < user (`~/.riley/skills/`) < workspace (`cwd/skills/`). Later directories override earlier ones:

```javascript
// lib/skills/index.js
function getSkillDirectories() {
  const dirs = [];
  dirs.push(path.join(__dirname, 'builtin'));          // Built-in (lowest priority)
  for (const dir of pluginSkillDirs.values()) {
    dirs.push(dir);                                     // Plugin skills
  }
  dirs.push(path.join(os.homedir(), '.riley', 'skills')); // User skills
  dirs.push(path.join(process.cwd(), 'skills'));           // Workspace (highest priority)
  return dirs;
}
```

Each skill file is parsed for YAML frontmatter containing name, description, triggers, tools, and category. The body becomes the skill's content:

```markdown
---
name: Check Deploy Status
description: Check the current deployment status for a project
triggers: [deploy status, is the deploy done, check deployment]
tools: [github_ops]
category: devops
---
# Steps
- Query the deployment API for the given project
- Report status, timestamp, and any errors
```

### Frontmatter Parsing

The system uses a custom YAML parser (not a full YAML library) that handles single-line values, quoted strings, and bracket-delimited arrays:

```javascript
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Handle arrays: [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      }
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: match[2] };
}
```

### Trigger-Based Matching (File Skills)

When a message arrives, the system checks it against each file-based skill's trigger list. Matching supports both substring inclusion and glob-like patterns with wildcards:

```javascript
function findRelevantSkills(message) {
  const skills = loadAllSkills();
  const messageLower = message.toLowerCase();
  const relevant = [];

  for (const skill of skills.values()) {
    for (const trigger of skill.triggers || []) {
      const triggerLower = trigger.toLowerCase();
      if (triggerLower.includes('*')) {
        const regex = new RegExp(triggerLower.replace(/\*/g, '.*'), 'i');
        if (regex.test(messageLower)) { relevant.push(skill); break; }
      } else if (messageLower.includes(triggerLower)) {
        relevant.push(skill); break;
      }
    }
  }
  return relevant;
}
```

Matched skills are injected into the system prompt as additional context for the LLM, not executed directly.

### Embedding-Based Vector Similarity (Database Skills)

For skills stored in the database (extracted from repeated patterns), the matcher uses pgvector cosine similarity. This is the more sophisticated matching path with two threshold tiers:

```javascript
// lib/skills/matcher.js
const REFLEX_THRESHOLD = 0.90;  // Auto-execute without LLM
const SKILL_THRESHOLD  = 0.85;  // Include skill in LLM context

async function match(queryText) {
  const queryEmbedding = await getEmbedding(queryText);

  // Search reflexes first (highest priority, auto-execute)
  const reflexResults = await searchSkills(queryEmbedding, tenantId, ['reflex'], 1);
  if (reflexResults.length > 0 && reflexResults[0].score > REFLEX_THRESHOLD) {
    return { type: 'reflex', match: reflexResults[0], action: 'execute', confidence: reflexResults[0].score };
  }

  // Search stable/trial skills
  const skillResults = await searchSkills(queryEmbedding, tenantId, ['stable', 'trial'], 5);
  const relevantSkills = skillResults.filter(s => s.score > SKILL_THRESHOLD);

  if (relevantSkills.length > 0) {
    return { type: 'skills', matches: relevantSkills.slice(0, 3), action: 'include_in_context' };
  }

  return { type: 'none', matches: [], action: 'compose_novel' };
}
```

The vector search uses pgvector's `<=>` operator for cosine distance, converted to a similarity score:

```sql
SELECT id, name, description, pipeline, (embedding <=> $1) as distance
FROM skills_v2
WHERE tenant_id = $2 AND embedding IS NOT NULL AND status = ANY($3)
ORDER BY embedding <=> $1 LIMIT $4
```

### Dispatch Flow

Messages are routed through a three-speed dispatch based on match quality:

```
Incoming Message
  |-- Reflex match (>0.90)?  -> Execute pipeline directly, no LLM     ~100ms
  |-- Skill match (>0.85)?   -> Guided LLM dispatch with skill context ~1-2s
  +-- No match               -> Full pipeline (compose novel)          ~3-5s
```

### Skill Lifecycle and Promotion

Skills progress through statuses: `trial` (newly extracted) -> `stable` (proven reliable) -> `reflex` (auto-execute). The promotion is based on hit count and success rate:

```javascript
async function createSkill({ name, description, pipeline, exampleQueries }) {
  // Generate centroid embedding from example queries
  const embeddings = await Promise.all(exampleQueries.map(q => getEmbedding(q)));
  const centroid = averageVectors(embeddings);

  await raw(
    `INSERT INTO skills_v2 (tenant_id, name, description, pipeline, embedding, example_queries, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'trial') RETURNING id`,
    [tenantId, name, description, JSON.stringify(pipeline), JSON.stringify(centroid), exampleQueries]
  );
}

async function promoteToReflex(skillId) {
  await raw(`UPDATE skills_v2 SET status = 'reflex', updated_at = NOW() WHERE id = $1`, [skillId]);
}
```

### Caching

File-based skills are cached in memory with a 60-second TTL. The cache is invalidated when plugin skill directories change:

```javascript
let skillCache = new Map();
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000;

function loadAllSkills(forceReload = false) {
  if (!forceReload && skillCache.size > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return skillCache;
  }
  // Reload from all directories...
}
```

## Implications

- Two parallel skill systems coexist: file-based (trigger matching, injected as context) and database-stored (embedding matching, can auto-execute as reflexes)
- File-based discovery means adding a skill is a file operation — no database migrations required
- Embedding-based matching requires vector infrastructure (pgvector, embedding API) but enables semantic matching without manually declared triggers
- The reflex threshold (0.90) is deliberately high to minimize false auto-executions — most matches will be skills (0.85+) that still route through the LLM
- Centroid embeddings from example queries mean skill matching quality depends on the diversity and representativeness of the example set
- Plugin skill directories integrate with the file-based system through `addSkillDirectory()`, allowing plugins to contribute skills without database access
- The workspace directory has highest priority, enabling per-project skill overrides

## Code Example

```javascript
// System prompt composition with skill injection
const skills = require('./lib/skills');
const matcher = require('./lib/skills/matcher');

async function dispatch(message) {
  // 1. Check database skills via embedding similarity
  const dbMatch = await matcher.match(message.text);

  if (dbMatch.type === 'reflex') {
    // Auto-execute without LLM
    return await executeSkillPipeline(dbMatch.match.pipeline);
  }

  // 2. Check file-based skills via trigger matching
  const fileSkills = skills.findRelevantSkills(message.text);

  // 3. Combine matched skills into context
  const allSkills = [
    ...(dbMatch.matches || []),
    ...fileSkills,
  ];

  if (allSkills.length > 0) {
    const skillSection = skills.formatForPrompt(allSkills);
    return await guidedDispatch(message, skillSection);
  }

  // 4. No matches — full pipeline
  return await fullPipeline(message);
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Dynamic System Prompt Composition](./dynamic-system-prompt-composition.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
- [Plugin System and Hot-Reload](./plugin-system-and-hot-reload.md)
