import pg from 'pg'

// .env is optional: DATABASE_URL may come from the shell instead.
try {
  process.loadEnvFile()
} catch {}

pg.types.setTypeParser(1082, (v) => v) // dates stay strings, so output does not depend on the time zone
pg.types.setTypeParser(20, Number)
pg.types.setTypeParser(1700, Number) // numeric: every amount here is small and synthetic

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/acme_ops'

export type Db = pg.Pool | pg.PoolClient | pg.Client

export function connect(max = 8): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max })
}

/** One connection outside the pool, named so pg_stat_activity can tell the demo's sessions apart. */
export async function session(name: string, statementTimeoutMs = 10_000): Promise<pg.Client> {
  const c = new pg.Client({
    connectionString: DATABASE_URL,
    application_name: name,
    statement_timeout: statementTimeoutMs,
  })
  await c.connect()
  return c
}

export async function resetSchema(db: Db, ...schemas: string[]): Promise<void> {
  for (const s of schemas) await db.query(`DROP SCHEMA IF EXISTS ${s} CASCADE; CREATE SCHEMA ${s}`)
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
