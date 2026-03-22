# Skill Extraction and Fast-Path Routing

> File-based YAML skill discovery with frontmatter metadata matching for fast-path dispatch, with designed (not yet operational) reflex promotion.

## Problem

An LLM orchestrator processes every incoming message through the same pipeline: full context assembly, tool declaration injection, and multi-turn LLM dispatch. But many messages are repetitive — "check the deploy status", "summarize today's activity", "approve task #42". Running a full LLM cycle for well-known operations wastes tokens and adds latency. The system should recognize common patterns and shortcut them.

## Context

> **Implementation status:** File-based YAML skill matching is operational. Reflex promotion and LLM-free execution are designed but not yet implemented.

- An orchestrator handling a mix of novel and repetitive user requests
- Skills defined as individual YAML files with frontmatter metadata
- Need to balance speed (fast-path) with accuracy (no false shortcuts)
- The system should be extensible — adding a new skill means adding a file, not modifying dispatch logic

## Solution

### File-Based Skill Discovery

Skills are defined as YAML files with frontmatter metadata. On startup, the system scans a skills directory, parses each file's frontmatter, and builds an in-memory index of available skills:

```javascript
// skills/loader.js
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

function discoverSkills(skillsDir) {
  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.yml'));
  const skills = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(skillsDir, file), 'utf8');
    const { data: frontmatter, content } = matter(raw);
    skills.push({
      name: frontmatter.name,
      triggers: frontmatter.triggers || [],
      description: frontmatter.description,
      body: content,
      file,
    });
  }

  return skills;
}
```

### YAML Frontmatter Format

Each skill file declares its identity and trigger patterns in frontmatter. The body contains the skill's execution instructions or template:

```yaml
---
name: check-deploy-status
description: Check the current deployment status for a project
triggers:
  - deploy status
  - is the deploy done
  - check deployment
---
# Steps
- Query the deployment API for the given project
- Report status, timestamp, and any errors
```

### Trigger Matching

When a message arrives, the system compares it against each skill's trigger list. Matching is substring- or keyword-based against the declared triggers — no embeddings, no database lookups:

```javascript
function matchSkill(message, skills) {
  const text = message.text.toLowerCase();

  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      if (text.includes(trigger.toLowerCase())) {
        return skill;
      }
    }
  }

  return null;
}
```

### Dispatch Flow

Messages are routed through a two-speed dispatch: matched skills get guided LLM handling with the skill body injected as context, while unmatched messages go through the full pipeline:

```
Incoming Message
  |-- Skill match?  -> Guided LLM dispatch (skill body as context)  ~1-2s
  +-- No match      -> Full pipeline                                 ~3-5s
```

### Reflex Promotion (Aspirational)

> **Not yet implemented.** The intended behavior is described below.

When the same skill fires repeatedly with consistent results, the system would promote it to a reflex — a direct mapping that bypasses the LLM entirely. A reflex that produces errors or user corrections would be demoted back to a skill. This creates a three-speed dispatch (reflex, skill, full pipeline) but only two speeds are currently operational.

## Implications

- File-based discovery means adding a skill is a file operation — no database migrations, no redeployment required for skill changes
- Trigger matching is simple string matching, which is fast but less flexible than semantic search — triggers must be explicitly declared
- No embeddings infrastructure is required, keeping the skill system lightweight and dependency-free
- Reflex promotion, if implemented, would create behavior invisible to the LLM — debugging would require checking the reflex registry
- Trigger overlap between skills can cause false matches — the first match wins, so file ordering matters
- Skills can be hot-reloaded by re-scanning the directory, enabling runtime updates without restarts

## Code Example

```javascript
// Complete skill discovery and dispatch
const skills = discoverSkills('./skills');

async function dispatch(message) {
  const skill = matchSkill(message, skills);

  if (skill) {
    // Inject skill body as additional context for the LLM
    return await guidedDispatch(message, skill.body);
  }

  return await fullPipeline(message);
}
```

## Related Patterns

- [Declarative Capability System](./declarative-capability-system.md)
- [Context Assembly Pipeline](./context-assembly-pipeline.md)
- [Evolution and Self-Improvement](./evolution-and-self-improvement.md)
