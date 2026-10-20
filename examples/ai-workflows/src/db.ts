import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'

// .env is optional: DATABASE_URL may come from the shell instead.
try {
  process.loadEnvFile()
} catch {}

pg.types.setTypeParser(1082, (v) => v) // dates stay strings, so output does not depend on the time zone
pg.types.setTypeParser(20, Number)

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/acme_agents'

export type Db = pg.Pool | pg.PoolClient

export function connect(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 4, options: '-c search_path=acme,audit' })
}

export async function setup(db: Db): Promise<void> {
  await db.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
}

/** Empties the ledger and restarts its clock. The data can be rebuilt without touching either. */
export async function resetLedger(db: Db): Promise<void> {
  await db.query('TRUNCATE audit.ledger RESTART IDENTITY')
  tick = 0
}

// A logical clock: every ledger row is one minute after the last, from a fixed anchor, so the
// ledger the demo prints is identical on every run.
const ANCHOR = Date.parse('2026-03-02T09:00:00Z')
let tick = 0
export const now = (): string => new Date(ANCHOR + tick++ * 60_000).toISOString().slice(0, 16).replace('T', ' ')

export const hash = (inputs: unknown): string =>
  createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 12)

export type Agent = 'questions' | 'analyst' | 'changes' | 'triage'

export async function record(db: Db, agent: Agent, actor: string, action: string, inputs: unknown, outcome: string): Promise<void> {
  await db.query('INSERT INTO ledger (at, agent, actor, action, inputs_hash, outcome) VALUES ($1, $2, $3, $4, $5, $6)', [
    now(), agent, actor, action, hash(inputs), outcome,
  ])
}
