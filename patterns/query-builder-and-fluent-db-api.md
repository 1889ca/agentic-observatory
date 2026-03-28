# Query Builder and Fluent DB API

> Chainable `.select().where().orderBy().limit().all()` query builder with overloaded entry points, full-text search, vector similarity search, and tenant-scoped CRUD operations.

## Problem

An orchestrator with dozens of modules querying a PostgreSQL database accumulates raw SQL strings everywhere. Each module constructs its own queries, handles its own parameter binding, and manages its own tenant scoping. This leads to SQL injection risks, inconsistent tenant isolation, and duplicated query logic spread across the codebase. Adding a new query capability (like vector search or read replica routing) requires touching every module.

## Context

- A PostgreSQL-backed system with 50+ tables and growing
- Multiple query patterns: simple lookups, full-text search, vector similarity search, transactions
- Originally multi-tenant with `tenant_id` scoping, now single-user but with legacy schema intact
- Some queries benefit from read replica routing for performance
- CRUD operations need automatic `tenant_id` injection for database consistency
- Raw SQL escape hatches are still needed for complex queries

## Solution

### Fluent SelectQuery Builder

The core is a `SelectQuery` class that accumulates query fragments through chainable methods, then builds and executes a parameterized SQL string:

```typescript
// builder.ts
export class SelectQuery {
  private table: string
  private columns: string
  private whereClauses: string[]
  private whereParams: unknown[]
  private joinClauses: string[]
  private orderByClauses: string[]
  private limitValue: number | null
  private offsetValue: number | null
  private _useReadReplica: boolean

  constructor(table: string) {
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

  where(condition: string, ...params: unknown[]): SelectQuery {
    this.whereClauses.push(condition)
    this.whereParams.push(...params)
    return this
  }

  whereIn(column: string, values: unknown[]): SelectQuery {
    if (values.length === 0) {
      this.whereClauses.push('1 = 0') // Empty IN returns nothing
      return this
    }
    const placeholders = values.map(() => '?').join(', ')
    this.whereClauses.push(`${column} IN (${placeholders})`)
    this.whereParams.push(...values)
    return this
  }

  useReadReplica(): SelectQuery {
    this._useReadReplica = true
    return this
  }

  async all(): Promise<Row[]> {
    const { sql, params } = this.build()
    if (this._useReadReplica && db.read) {
      return db.read(sql, params)
    }
    return db.query(sql, params)
  }

  async one(): Promise<Row | undefined> {
    const { sql, params } = this.build()
    return db.queryOne(sql, params)
  }

  async count(): Promise<number> {
    const original = this.columns
    this.columns = 'COUNT(*) as count'
    const { sql, params } = this.build()
    this.columns = original
    const result = await db.queryOne(sql, params)
    return (result?.count as number) || 0
  }
}
```

### Overloaded Entry Point

The `select()` function supports two calling conventions -- builder mode for complex queries and options mode for simple lookups:

```typescript
// select.ts
export function select(table: string): SelectQuery
export function select(table: string, options: SelectOptions): Promise<Row[]>
export function select(table: string, options?: SelectOptions): SelectQuery | Promise<Row[]> {
  const query = new SelectQuery(table)

  if (!options) {
    return query // Return builder for chaining
  }

  // Apply options and execute immediately
  if (options.where) {
    for (const [key, value] of Object.entries(options.where)) {
      query.where(`${key} = ?`, value)
    }
  }
  if (options.readReplica) query.useReadReplica()
  if (options.orderBy) query.orderBy(options.orderBy)
  if (options.limit) query.limit(options.limit)

  return query.all()
}
```

### Tenant-Scoped CRUD

Write operations automatically inject `tenant_id=1` for tables that have the column, using an exemption set for tables that don't:

```typescript
// crud.ts
const TENANT_EXEMPT_TABLES = new Set([
  'tenants', 'sessions', 'agent_settings', 'tags', 'note_tags',
  'conversation_messages', 'activity_log', 'memory_vectors',
  // ... ~40 exempt tables
])

export async function insert(table: string, data: Record<string, unknown>): Promise<string | number> {
  if (!data.tenant_id && !TENANT_EXEMPT_TABLES.has(table)) {
    data = { ...data, tenant_id: 1 }
  }

  const columns = Object.keys(data)
  const placeholders = columns.map(() => '?').join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
  const result = await db.run(sql, Object.values(data))
  return result.lastId
}

export async function upsert(
  table: string,
  data: Record<string, unknown>,
  conflictColumns: string | string[],
  updateData: Record<string, unknown> | null = null,
): Promise<string | number> {
  if (!data.tenant_id && !TENANT_EXEMPT_TABLES.has(table)) {
    data = { ...data, tenant_id: 1 }
  }

  const updateCols = updateData || data
  const updateClause = Object.keys(updateCols)
    .map((col) => `${col} = EXCLUDED.${col}`)
    .join(', ')

  const sql = `
    INSERT INTO ${table} (${Object.keys(data).join(', ')})
    VALUES (${Object.keys(data).map(() => '?').join(', ')})
    ON CONFLICT (${Array.isArray(conflictColumns) ? conflictColumns.join(', ') : conflictColumns})
    DO UPDATE SET ${updateClause}
    RETURNING *
  `
  const result = await db.queryOne(sql, Object.values(data))
  return (result?.id as string | number) || 0
}
```

### Full-Text and Vector Search

Specialized search functions compose the `SelectQuery` builder with PostgreSQL-specific operators:

```typescript
// search.ts
export async function search(table: string, searchText: string, options = {}): Promise<Row[]> {
  const column = options.column || 'search_vector'
  const query = new SelectQuery(table).where(
    `${column} @@ plainto_tsquery('english', ?)`,
    searchText
  )
  if (options.orderBy) query.orderBy(options.orderBy)
  if (options.limit) query.limit(options.limit)
  return query.all()
}

export async function vectorSearch(table: string, embedding: number[], options = {}): Promise<Row[]> {
  const column = options.column || 'embedding'
  const limit = options.limit || 10

  let sql = `SELECT *, (${column} <=> $1) as distance FROM ${table}`
  const params: unknown[] = [JSON.stringify(embedding)]

  if (options.where) {
    sql += ` WHERE ${options.where}`
    if (options.whereParams) params.push(...options.whereParams)
  }

  sql += ` ORDER BY distance ASC LIMIT $${params.length + 1}`
  params.push(limit)
  return db.query(sql, params)
}
```

### Raw SQL With Tenant Stubs

For complex queries that can't use the builder, raw functions prepend `tenant_id=1` so existing SQL with `$1` placeholders works unchanged:

```typescript
// raw.ts
export async function rawWithTenant(sql: string, params: unknown[] = []): Promise<Row[]> {
  return db.query(sql, [1, ...params])
}
```

## Implications

- The fluent API prevents SQL injection by always parameterizing values -- no string interpolation of user input
- The overloaded `select()` entry point means simple queries stay one-liners while complex queries get full builder expressiveness
- The `TENANT_EXEMPT_TABLES` set requires maintenance when adding new tables, but prevents silent data isolation bugs
- Read replica routing is opt-in per query, avoiding accidental stale reads where consistency matters
- `whereIn` with an empty array returns no rows (`1 = 0`) rather than throwing or returning all rows -- a deliberate safety choice
- Vector search uses raw SQL rather than the builder because pgvector's `<=>` operator and `$1`-style parameters don't fit the `?`-placeholder pattern cleanly
- The `count()` method temporarily mutates `columns` and restores it -- not ideal for concurrent use, but safe because each `SelectQuery` instance is single-use

## Code Example

```typescript
// Simple lookup with options (executes immediately)
const activeTasks = await select('documents', {
  where: { type: 'task', status: 'active' },
  orderBy: 'priority DESC',
  limit: 10,
})

// Complex query with builder chaining
const results = await select('documents')
  .select('d.id, d.title, d.data, p.name as project_name')
  .from('documents d')
  .leftJoin('documents p', 'd.parent_id = p.id')
  .where('d.type = ?', 'task')
  .where('d.status != ?', 'archived')
  .whereIn('d.parent_id', projectIds)
  .orderBy('d.created_at DESC')
  .useReadReplica()
  .limit(50)
  .all()

// Full-text search
const matches = await search('facts', 'prefers dark mode', { limit: 5 })

// Upsert with conflict resolution
await upsert('agent_settings', { key: 'autonomy_level', value: 'high' }, 'key')
```

## Related Patterns

- [Database Abstraction and Schema Management](./database-abstraction-and-schema-management.md)
- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
- [Request-Scoped Context](./request-scoped-context.md)
