# Database Abstraction and Schema Management

> PostgreSQL abstraction with a TypeScript query handler compiled to JS, a fluent `SelectQuery` builder, domain-specific schema modules, and file-based migrations managed by `node-pg-migrate`.

## Problem

Direct database access scattered across an application creates several compounding problems. Connection management gets duplicated — every module that touches the database opens its own connection or assumes one exists. Query construction leaks PostgreSQL-specific syntax into business logic, making it impossible to reason about data access patterns. When the database schema evolves, ad-hoc migration scripts create versioning confusion. And without a fluent builder, every module that needs dynamic WHERE clauses rebuilds the same boilerplate: accumulating conditions, tracking parameter indices, concatenating strings.

## Context

- A Node.js orchestrator using PostgreSQL as its primary data store
- The query handler is authored in TypeScript and compiled to JavaScript — the rest of the codebase is plain JS
- Multiple modules need database access but should not manage connections or build raw SQL directly
- Schema evolves through file-based migrations that run via `node-pg-migrate`
- Schema definitions are organized into domain-specific modules (people, projects, knowledge, messaging, etc.)
- Both raw SQL and fluent builder access patterns are needed — some queries are too complex for a builder
- Read replicas may be used for heavy read operations

## Solution

### Query Handler Architecture

The database layer is split into a compiled TypeScript query handler (`lib/db/query-handler/`) and a plain JS entry point (`lib/db/index.js`) that re-exports everything. The query handler is organized into focused sub-modules:

```javascript
// lib/db/query-handler.js (compiled from TypeScript)
// Re-exports organized by concern:

// Builder
exports.SelectQuery   // Fluent chainable query builder
exports.db            // Low-level DB adapter reference

// CRUD operations
exports.select        // Returns a SelectQuery instance
exports.insert        // Insert row, return ID
exports.insertMany    // Batch insert
exports.update        // Update rows matching condition
exports.del           // Delete rows matching condition
exports.upsert        // Insert or update on conflict

// Raw SQL (unscoped)
exports.raw           // Execute raw SQL, return rows
exports.rawRead       // Raw SQL routed to read replica
exports.rawOne        // Raw SQL, return first row
exports.rawOneRead    // Raw SQL first row, read replica

// Tenant-scoped raw SQL
exports.rawWithTenant         // Auto-inject tenant_id
exports.rawWithTenantRead     // Tenant-scoped on read replica

// Search & transactions
exports.transaction   // Wrap operations in a transaction
exports.search        // Full-text search helper
exports.vectorSearch  // pgvector similarity search
```

### Fluent SelectQuery Builder

The `SelectQuery` class eliminates duplicated dynamic WHERE clause building across the codebase. Modules chain methods instead of concatenating SQL strings:

```javascript
// lib/db/query-handler/builder.ts (compiled to JS)
class SelectQuery {
  constructor(table) {
    this.table = table
    this.columns = '*'
    this.whereClauses = []
    this.whereParams = []
    this.joinClauses = []
    this.orderByClauses = []
    this.limitValue = null
    this.offsetValue = null
    this._useReadReplica = false
  }

  select(columns) { /* set columns */ return this }
  where(condition, ...params) { /* add WHERE clause */ return this }
  whereIn(column, values) { /* add IN clause */ return this }
  whereJsonContains(column, path, value) { /* JSONB @> operator */ return this }
  join(table, condition, type = 'INNER') { /* add JOIN */ return this }
  leftJoin(table, condition) { return this.join(table, condition, 'LEFT') }
  orderBy(column, direction) { /* add ORDER BY */ return this }
  limit(n) { /* set LIMIT */ return this }
  offset(n) { /* set OFFSET */ return this }
  useReadReplica() { /* route to read replica */ return this }
  skipTenantScope() { /* no-op, kept for API compat */ return this }

  // Terminal methods
  async all() { /* execute and return all rows */ }
  async one() { /* execute and return first row */ }
  async count() { /* execute COUNT(*) variant */ }
}
```

Parameter placeholders use `?` internally and are converted to PostgreSQL `$1, $2` format at build time. The builder handles edge cases like empty `IN` clauses (returns no rows) and direction-aware `ORDER BY` parsing.

### Domain-Specific Schema Modules

Schema definitions live in `lib/db-postgres/schema/`, organized by domain rather than as a single monolithic file:

```
lib/db-postgres/schema/
  core.js            # Base tables (documents, preferences, audit)
  people.js          # Person identifiers, relationships
  projects.js        # Projects, milestones
  knowledge.js       # Knowledge graph, entities
  messaging.js       # Conversations, messages
  financial.js       # Budgets, transactions
  goals.js           # Objectives, key results
  learning.js        # Self-improvement tracking
  worker-pipelines.js # Worker task pipelines
  ...20+ domain files
```

Each module exports CREATE TABLE statements for its domain. The schema loader composes them at migration time.

### File-Based Migrations

Migrations are managed through `node-pg-migrate` with timestamped files in the `migrations/` directory:

```
migrations/
  1767194177505_baseline-schema.js
  1767202750141_person-identifiers.js
  1767300000001_graph-layer.js
  1767300000002_knowledge-layer.js
  1767300000003_capability-registry.js
  ...
```

Each migration file exports `up` and `down` functions. The baseline migration composes all domain schema modules for fresh installs; subsequent migrations handle incremental changes.

### Companion QueryBuilder for Complex Dynamic Queries

A separate `QueryBuilder` class (`lib/db/query-builder.js`) provides an alternative fluent interface for more complex scenarios with dynamic SET clauses, conditional joins, and LIKE patterns:

```javascript
// lib/db/query-builder.js
const qb = new QueryBuilder('worker_tasks')
  .where('status', 'pending')
  .whereIn('task_type', ['coding', 'code-review'])
  .whereLike('description', '%deploy%')
  .orderBy('priority', 'DESC')
  .limit(10)

const { sql, params } = qb.build()
```

## Implications

- The TypeScript query handler gives type safety at authorship time while the compiled JS integrates seamlessly with the plain-JS codebase — no runtime TypeScript dependency
- Domain-specific schema modules prevent a single 2000-line schema file and make it clear which tables belong to which feature area
- `node-pg-migrate` handles migration ordering and tracking automatically — no custom advisory-lock code needed
- The fluent builder eliminates the most common source of SQL injection in dynamic queries while keeping raw SQL available for complex operations
- Read replica routing via `useReadReplica()` and `rawRead()` is opt-in per query — callers that need write-after-read consistency use the default writer
- `skipTenantScope()` is a no-op kept for API compatibility — the system is single-tenant, but the method signature remains for future flexibility
- Parameter placeholder conversion (`?` to `$N`) happens at build time, not at the caller level — callers write natural parameterized queries

## Code Example

```javascript
// Usage from a business logic module
const { select, insert, raw, rawOne } = require('../db/query-handler')

// Fluent builder for filtered queries
async function getActiveTasks(workerType, status) {
  let query = select('worker_tasks')
    .where('archived_at IS NULL')
    .orderBy('created_at DESC')
    .limit(50)

  if (workerType) query = query.where('worker_type = ?', workerType)
  if (status) query = query.where('status = ?', status)

  return query.all()
}

// Raw SQL for complex aggregations
async function getTaskStats() {
  return rawOne(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running') as running,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COALESCE(SUM(cost_usd) FILTER (
        WHERE completed_at > NOW() - INTERVAL '24 hours'
      ), 0) as cost_24h
    FROM worker_tasks
  `)
}

// Insert with automatic ID return
async function createPreference(category, key, value) {
  return insert('preferences', {
    category,
    preference_key: key,
    value: JSON.stringify(value),
    source: 'explicit',
    confidence: 1.0,
  })
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
