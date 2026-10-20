import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { sleep } from './db.ts'

/**
 * The ordinary runner: applies every .sql file in `dir` that `<schema>.migrations` has not
 * recorded, in name order, and records it by name. A recorded file is skipped forever, which is
 * what makes running this on every deploy safe, and what makes an edit to an applied file a
 * no-op on every database that already ran it (part 1).
 *
 * `lockTimeoutMs` undefined is the runner as it was: each file in a plain transaction, waiting
 * for its locks as long as it takes (part 4). Set, every file runs in `withLockTimeout`.
 */
export async function migrate(
  client: pg.ClientBase,
  dir: string,
  schema: string,
  opts: Partial<LockOpts> = {},
): Promise<{ applied: string[]; skipped: string[] }> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  await client.query(`SET search_path = ${schema}`)
  await client.query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await client.query<{ name: string }>('SELECT name FROM migrations')).rows.map((r) => r.name))
  const applied: string[] = []
  const skipped: string[] = []
  try {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) {
        skipped.push(name)
        continue
      }
      const work = async () => {
        await client.query(readFileSync(join(dir, name), 'utf8'))
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [name])
      }
      if (opts.lockTimeoutMs === undefined) {
        await client.query('BEGIN')
        try {
          await work()
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK')
          throw e
        }
      } else {
        await withLockTimeout(client, work, { attempts: 3, backoffMs: 1000, ...opts, lockTimeoutMs: opts.lockTimeoutMs })
      }
      applied.push(name)
    }
  } finally {
    await client.query('RESET search_path')
  }
  return { applied, skipped }
}

export type LockOpts = {
  lockTimeoutMs: number
  attempts: number
  backoffMs: number
  onRetry?: OnRetry
  /** A second connection; when given, each attempt records who held its lock and who queued behind it. */
  monitor?: pg.ClientBase
}

export type Session = { name: string; state: string; query: string }
/** What one failed attempt saw while it waited: who held the lock, and who queued behind it. */
export type Seen = { holders: Session[]; queued: Session[] }
export type OnRetry = (attempt: number, error: Error, seen: Seen) => Promise<void> | void

const SESSION = `application_name AS name, state, regexp_replace(query, '\\s+', ' ', 'g') AS query`

/**
 * Samples, every 50 ms until `stop`, the sessions blocking `pid` and the sessions `pid` blocks.
 * Postgres grants locks in arrival order, so a reader that arrives while a migration waits for
 * an exclusive lock waits behind the migration, not behind the long reader: those are the
 * sessions a migration with no lock_timeout would hold up for as long as the long reader lives.
 */
function watch(monitor: pg.ClientBase, pid: number): { stop: () => Promise<Seen> } {
  const holders = new Map<string, Session>()
  const queued = new Map<string, Session>()
  let running = true
  const loop = (async () => {
    while (running) {
      const h = await monitor.query<Session>(`SELECT ${SESSION} FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids($1))`, [pid])
      const q = await monitor.query<Session>(`SELECT ${SESSION} FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])
      for (const s of h.rows) holders.set(s.name, s)
      for (const s of q.rows) queued.set(s.name, s)
      await sleep(50)
    }
  })()
  const sorted = (m: Map<string, Session>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { stop: async () => ((running = false), await loop, { holders: sorted(holders), queued: sorted(queued) }) }
}

/**
 * Runs `work` in a transaction whose lock waits are bounded. `SET LOCAL` scopes the timeout to
 * this transaction, so the session's other statements keep their own settings. On 55P03
 * (lock_not_available) the whole transaction is rolled back and retried after a growing pause;
 * any other error, or the last attempt's timeout, is thrown.
 *
 * Why not just a statement_timeout: that also cancels a migration that is slow for honest
 * reasons (a big backfill) and does nothing about the queue until it fires. lock_timeout only
 * bounds the wait for a lock, and the wait is what queues everyone else.
 */
export async function withLockTimeout(
  client: pg.ClientBase,
  work: () => Promise<void>,
  { lockTimeoutMs, attempts, backoffMs, onRetry, monitor }: LockOpts,
): Promise<number> {
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
  for (let attempt = 1; ; attempt++) {
    await client.query('BEGIN')
    const watcher = monitor && watch(monitor, pid)
    try {
      await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`)
      await work()
      await client.query('COMMIT')
      await watcher?.stop()
      return attempt
    } catch (e) {
      await client.query('ROLLBACK')
      const seen = (await watcher?.stop()) ?? { holders: [], queued: [] }
      const err = e as Error & { code?: string; seen?: Seen }
      err.seen = seen
      if (err.code !== '55P03' || attempt >= attempts) throw err
      await onRetry?.(attempt, err, seen)
      await sleep(backoffMs * 2 ** (attempt - 1))
    }
  }
}
