# Capability Manifest Registration

> Pluggable project registration via declarative manifests, enabling the orchestrator to discover and use project capabilities without hardcoding.

## Problem

An orchestrator managing multiple projects needs to know what each project offers — its search endpoints, available flows, environment variables, MCP servers, and task definitions. Hardcoding this in the orchestrator creates tight coupling: adding a project means editing orchestrator code. Worse, different projects have different capabilities (some have MCP servers, some have CLI tools, some have HTTP APIs), so the integration surface is inconsistent.

## Context

- One orchestrator managing 5-50 independent projects
- Each project has different capabilities (search, flows, tasks, MCP tools)
- Projects are added and removed over time
- The orchestrator needs to discover capabilities at startup
- Different projects use different integration patterns (MCP, HTTP, CLI scripts)

## Solution

### Declarative Capability Files

Each project declares its capabilities in a `.riley/capabilities.yaml` file at its root:

```yaml
name: my-project
description: What this project does

env:
  API_KEY: ${MY_PROJECT_API_KEY}

mcp:
  server: npx -y @my/mcp-server
  headers:
    Authorization: Bearer ${MY_PROJECT_TOKEN}

search:
  type: mcp          # or "http" or "script"
  tool: search_docs   # MCP tool name
  query_param: query   # parameter name for search queries

flows:
  deploy:
    description: Build and deploy the project
    steps:
      - build: Run npm build and verify output
      - deploy: Push to production
    on_complete: stop

  audit:
    description: Run security audit
    steps:
      - scan: Run dependency and code audit
      - report: Generate findings report
    on_complete: stop
```

### Startup Discovery

At startup, the orchestrator scans all registered project directories for `.riley/capabilities.yaml`:

```javascript
async function loadCapabilities(projectDirs) {
  const registry = {};
  for (const dir of projectDirs) {
    const capFile = path.join(dir, '.riley', 'capabilities.yaml');
    if (fs.existsSync(capFile)) {
      const caps = yaml.parse(fs.readFileSync(capFile, 'utf8'));
      caps.workdir = dir;
      registry[caps.name] = caps;
    }
  }
  return registry;
}
```

### Environment Variable Interpolation

Capability files reference secrets via `${VAR_NAME}` syntax. The orchestrator resolves these from its environment at load time, keeping secrets out of project repos:

```javascript
function interpolateEnv(value) {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}
```

### Unified Search Interface

Despite projects using different search backends (MCP tools, HTTP APIs, CLI scripts), the orchestrator presents a uniform search interface. The capability manifest declares which type and the orchestrator adapts:

```javascript
async function searchProject(project, query) {
  const search = project.search;
  switch (search.type) {
    case 'mcp':
      return await mcpCall(project.mcp, search.tool, { [search.query_param]: query });
    case 'http':
      return await fetch(`${search.url}?q=${encodeURIComponent(query)}`);
    case 'script':
      return await exec(search.command.replace('{query}', query), { cwd: project.workdir });
  }
}
```

### Autonomy Gating

A companion file `.riley/autonomy.yaml` declares which decisions the orchestrator can make autonomously per project:

```yaml
decisions:
  deploy: require_input           # always ask
  pattern-update: self_approve    # do it silently
  dependency-upgrade: require_input
```

This enables per-project governance without centralizing all rules in the orchestrator.

## Implications

- YAML parsing adds a dependency and potential for syntax errors in project configs
- Environment variable interpolation means the orchestrator's env must have all project secrets
- Capability discovery is startup-only — adding a project requires restarting the orchestrator (or implementing hot-reload)
- No schema validation on capability files means malformed configs fail at runtime
- The autonomy.yaml split means two files to maintain per project
- MCP session management adds state that must be cleaned up on project removal

## Code Example

```javascript
// Flow dispatch using capability registry
async function startFlow(projectName, flowName, context) {
  const project = registry[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  const flowDef = project.flows?.[flowName];
  if (!flowDef) throw new Error(`No flow '${flowName}' in ${projectName}`);

  const flowId = `${projectName}:${flowName}:${Date.now()}`;
  await db.run(`INSERT INTO flows (id, project, flow_name, status, context)
                VALUES (?, ?, ?, 'running', ?)`,
    [flowId, projectName, flowName, context]);

  // Execute first step with project's working directory
  await executeStep(flowId, 0, {
    cwd: project.workdir,
    env: resolveEnv(project.env),
    prompt: interpolate(flowDef.steps[0].prompt, { context })
  });

  return flowId;
}
```

## Related Patterns

- [Scheduled Autonomous Maintenance](./scheduled-autonomous-maintenance.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
- [Flow Recovery and Resilience](./flow-recovery-and-resilience.md)
- [Orchestrator-Satellite Communication](./orchestrator-satellite-communication.md)
