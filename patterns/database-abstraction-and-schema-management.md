# Database Abstraction and Schema Management

> PostgreSQL abstraction layer with lazy initialization, advisory-lock-protected schema migrations, connection pooling, and dual read/write API that hides database specifics from the rest of the codebase.

## Problem

Direct database access scattered across an application creates several compounding problems. Connection management gets duplicated — every module that touches the database opens its own connection or assumes one exists. Schema migrations run at startup, but without coordination, two instances starting simultaneously can run the same migration concurrently, corrupting schema state or hitting unique constraint violations on migration tracking tables. Query construction leaks PostgreSQL-specific syntax into business logic, making it impossible to reason about data access patterns or swap storage backends. And when the database is temporarily unreachable, every caller needs its own retry logic or the application crashes on the first transient network blip.

## Context

- A Node.js orchestrator using PostgreSQL as its primary data store
- Multiple modules need database access but should not manage connections directly
- The application may run multiple instances behind a load balancer, all sharing the same database
- Schema evolves over time with additive migrations that must run exactly once
- Some modules only read data while others perform writes — different access patterns benefit from different APIs
- The database connection should not block application startup if it's temporarily unavailable

## Solution

### Lazy Initialization with Connection Pooling

The database module exports a ready-to-use API, but the actual connection pool isn't created until the first query. This avoids blocking startup and means modules can import the database layer at load time without triggering a connection attempt:

```typescript
// lib/db.ts
import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

function getPoolConfig(): PoolConfig {
  return {
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  // Prevent multiple concurrent initialization attempts
  if (!initPromise) {
    initPromise = initializePool();
  }

  return initPromise;
}

async function initializePool(): Promise<Pool> {
  const newPool = new Pool(getPoolConfig());

  newPool.on('error', (err) => {
    logger.error({ err }, 'Unexpected pool error');
    pool = null;
    initPromise = null;
  });

  // Verify connectivity with a test query
  const client = await newPool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }

  pool = newPool;
  logger.info('Database pool initialized');
  return newPool;
}
```

### Advisory Locks for Schema Migration

PostgreSQL advisory locks provide application-level locking without creating lock tables. Before running migrations, the process acquires an advisory lock using a fixed lock ID. Any other instance attempting to migrate simultaneously will block until the first one finishes:

```typescript
// lib/db-postgres/migrate.ts
const MIGRATION_LOCK_ID = 839271; // Arbitrary but fixed

async function runMigrations(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    // Acquire advisory lock — blocks until available
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    logger.info('Migration lock acquired');

    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Determine which migrations have already run
    const { rows: applied } = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.map((r) => r.version));

    // Run pending migrations in order
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;

      logger.info({ version: migration.version, name: migration.name }, 'Running migration');
      await client.query('BEGIN');

      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    // Release advisory lock — even if migrations failed
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    client.release();
    logger.info('Migration lock released');
  }
}
```

### Dual Read/Write API

The abstraction provides separate helpers for read and write operations. Read operations return rows directly. Write operations (insert, update, delete) return metadata about affected rows. This separation makes access patterns explicit and enables future read-replica routing:

```typescript
// lib/db.ts — public API

/** Execute a read query, returning rows */
async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = await getPool();
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

/** Insert a row, returning the inserted record */
async function insert<T = Record<string, unknown>>(
  table: string,
  data: Record<string, unknown>
): Promise<T> {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map((_, i) => `$${i + 1}`);

  const sql = `
    INSERT INTO ${escapeIdentifier(table)} (${keys.map(escapeIdentifier).join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `;

  const pool = await getPool();
  const { rows } = await pool.query(sql, values);
  return rows[0] as T;
}

/** Update rows matching a condition */
async function update(
  table: string,
  data: Record<string, unknown>,
  where: Record<string, unknown>
): Promise<number> {
  const setClauses: string[] = [];
  const whereClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    setClauses.push(`${escapeIdentifier(key)} = $${paramIndex++}`);
    values.push(value);
  }

  for (const [key, value] of Object.entries(where)) {
    whereClauses.push(`${escapeIdentifier(key)} = $${paramIndex++}`);
    values.push(value);
  }

  const sql = `
    UPDATE ${escapeIdentifier(table)}
    SET ${setClauses.join(', ')}
    WHERE ${whereClauses.join(' AND ')}
  `;

  const pool = await getPool();
  const result = await pool.query(sql, values);
  return result.rowCount ?? 0;
}

/** Delete rows matching a condition */
async function remove(
  table: string,
  where: Record<string, unknown>
): Promise<number> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(where)) {
    whereClauses.push(`${escapeIdentifier(key)} = $${paramIndex++}`);
    values.push(value);
  }

  const sql = `
    DELETE FROM ${escapeIdentifier(table)}
    WHERE ${whereClauses.join(' AND ')}
  `;

  const pool = await getPool();
  const result = await pool.query(sql, values);
  return result.rowCount ?? 0;
}
```

### Connection Failure Recovery

The pool error handler nullifies the cached pool, forcing the next query to re-initialize. Combined with the lazy init pattern, this means transient database outages are recovered from automatically — the next operation triggers a fresh connection attempt:

```typescript
newPool.on('error', (err) => {
  logger.error({ err }, 'Pool connection lost — will reinitialize on next query');
  pool = null;
  initPromise = null;
});
```

Callers that need to handle database unavailability can catch the connection error and degrade gracefully rather than crashing.

## Implications

- Lazy initialization means the application starts even if the database is temporarily unreachable — useful for orchestrators that have non-database functionality
- Advisory locks are session-scoped — if the process crashes mid-migration, PostgreSQL automatically releases the lock when the connection drops
- The dual API makes it easy to audit which modules perform writes vs. reads, and opens the door to read-replica routing without changing callers
- Parameterized queries via `$1, $2` placeholders prevent SQL injection without requiring an ORM
- The `escapeIdentifier` function is critical for table/column names — without it, dynamic table names would be an injection vector
- Connection pooling bounds concurrent database connections, preventing connection exhaustion under load
- No ORM overhead — the abstraction is thin enough that callers can still write raw SQL when the helpers don't fit

## Code Example

```typescript
// Usage from a business logic module — no pool management, no SQL injection concerns
import { query, insert, update, remove } from '../lib/db';

interface Task {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}

async function getActiveTasks(): Promise<Task[]> {
  return query<Task>(
    'SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC',
    ['active']
  );
}

async function createTask(name: string): Promise<Task> {
  return insert<Task>('tasks', {
    name,
    status: 'active',
    created_at: new Date(),
  });
}

async function completeTask(taskId: string): Promise<void> {
  const affected = await update('tasks', { status: 'completed' }, { id: taskId });
  if (affected === 0) {
    throw new Error(`Task ${taskId} not found`);
  }
}

async function purgeOldTasks(beforeDate: Date): Promise<number> {
  return remove('tasks', { status: 'completed' });
}
```

## Related Patterns

- [Distributed Job Locking](./distributed-job-locking.md)
- [Graceful Degradation and Optional Init](./graceful-degradation-and-optional-init.md)
- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
