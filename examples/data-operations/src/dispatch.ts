import type pg from 'pg'

/**
 * A three-field schedule, "minute hour weekday" (weekday 0 = Sunday), each field `*`, `*\/n`,
 * a number, a range `a-b`, or a comma list of those. Smaller than cron on purpose: no day of
 * month, no month, no names. Throws on anything it cannot read, so a typo fails at registration
 * instead of silently never firing.
 */
export function parseSchedule(expr: string): (at: Date) => boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 3) throw new Error(`schedule "${expr}": want 3 fields (minute hour weekday)`)
  const [min, hour, dow] = fields.map((f, i) => field(f, [59, 23, 6][i]!, expr))
  return (at) => min!(at.getUTCMinutes()) && hour!(at.getUTCHours()) && dow!(at.getUTCDay())
}

function field(f: string, max: number, expr: string): (v: number) => boolean {
  const parts = f.split(',').map((p) => {
    const step = /^\*\/(\d+)$/.exec(p)
    if (p === '*') return () => true
    if (step) return (v: number) => v % Number(step[1]) === 0
    const range = /^(\d+)(?:-(\d+))?$/.exec(p)
    if (!range) throw new Error(`schedule "${expr}": cannot read "${p}"`)
    const [lo, hi] = [Number(range[1]), Number(range[2] ?? range[1])]
    if (hi > max || lo > hi) throw new Error(`schedule "${expr}": "${p}" out of range 0-${max}`)
    return (v: number) => v >= lo && v <= hi
  })
  return (v) => parts.some((m) => m(v))
}

export async function setupDispatch(db: pg.ClientBase | pg.Pool, schema: string): Promise<void> {
  await db.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE;
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.jobs (name text PRIMARY KEY, schedule text NOT NULL, registered_at timestamptz NOT NULL);
    -- The kill switch: one row, read every tick. Absent means "never seeded", not "nothing is off".
    CREATE TABLE ${schema}.settings (key text PRIMARY KEY, value text[] NOT NULL);
    CREATE TABLE ${schema}.job_runs (job text NOT NULL, started_at timestamptz NOT NULL, ok boolean NOT NULL, note text);
  `)
}

export type Ctx = { at: Date; log: (note: string) => void }
export type Route = (ctx: Ctx) => Promise<void>

const MINUTE = 60_000
const LOOKBACK = 24 * 60 // minutes; a dispatcher down longer than a day does not replay the backlog

/**
 * Was any minute in (since, at] one the schedule fires on? Asking this instead of "does `at`
 * match" means a tick that runs late, or a host that skips a minute, still starts the job once.
 */
export function firedSince(matches: (at: Date) => boolean, since: Date, at: Date, lookbackMin = LOOKBACK): boolean {
  const end = Math.floor(at.getTime() / MINUTE)
  const start = Math.max(Math.floor(since.getTime() / MINUTE) + 1, end - lookbackMin)
  for (let m = start; m <= end; m++) if (matches(new Date(m * MINUTE))) return true
  return false
}

export type TickResult = { ran: string[]; switchedOff: string[]; standDown?: string }

/**
 * One tick: read the kill switch and every job's last start in one query, run every job whose
 * schedule fired since it last started and whose name is not switched off, log a run row each.
 *
 * If the switch row is missing or cannot be read, nothing runs this tick. Treating "could not
 * read the list" as "nothing is switched off" would start every job someone turned off.
 */
export async function tick(db: pg.ClientBase | pg.Pool, schema: string, routes: Record<string, Route>, at: Date): Promise<TickResult> {
  let rows: { name: string; schedule: string; since: Date; off: string[] | null }[]
  try {
    rows = (
      await db.query(
        `SELECT j.name, j.schedule, coalesce(max(r.started_at), j.registered_at) AS since,
                (SELECT value FROM ${schema}.settings WHERE key = 'disabled_jobs') AS off
           FROM ${schema}.jobs j LEFT JOIN ${schema}.job_runs r ON r.job = j.name
          GROUP BY j.name ORDER BY j.name`,
      )
    ).rows
  } catch (e) {
    return { ran: [], switchedOff: [], standDown: `cannot read jobs or kill switch: ${(e as Error).message}` }
  }
  if (rows.length && rows[0]!.off === null) return { ran: [], switchedOff: [], standDown: 'no disabled_jobs row; running nothing until one exists' }
  const off = new Set(rows[0]?.off ?? [])
  const result: TickResult = { ran: [], switchedOff: [] }
  for (const job of rows) {
    if (!firedSince(parseSchedule(job.schedule), job.since, at)) continue
    if (off.has(job.name)) {
      result.switchedOff.push(job.name)
      continue
    }
    const notes: string[] = []
    let ok = true
    try {
      await routes[job.name]!({ at, log: (n) => notes.push(n) })
    } catch (e) {
      ok = false
      notes.push((e as Error).message)
    }
    await db.query(`INSERT INTO ${schema}.job_runs VALUES ($1, $2, $3, $4)`, [job.name, at, ok, notes.join('; ') || null])
    result.ran.push(job.name)
  }
  return result
}

export async function register(db: pg.ClientBase | pg.Pool, schema: string, routes: Record<string, Route>, jobs: Record<string, string>, at: Date): Promise<void> {
  for (const [name, schedule] of Object.entries(jobs)) {
    parseSchedule(schedule)
    if (!routes[name]) throw new Error(`job ${name} has no route`)
    await db.query(`INSERT INTO ${schema}.jobs VALUES ($1, $2, $3)`, [name, schedule, at])
  }
}

export type LastRun = { job: string; runs: number; last: string | null; switchedOff: boolean; warn: string | null }

/**
 * Every job's last run, and a warning for any job whose schedule fired in the window with no run
 * logged: switched off, or never reached. "No runs logged" is what a silent job looks like, and
 * this is the one place it shows.
 */
export async function lastRuns(db: pg.ClientBase | pg.Pool, schema: string, from: Date, to: Date): Promise<LastRun[]> {
  const { rows } = await db.query<{ job: string; schedule: string; runs: number; last: Date | null; off: boolean }>(
    `SELECT j.name AS job, j.schedule, count(r.*)::int AS runs, max(r.started_at) AS last,
            j.name = ANY(coalesce((SELECT value FROM ${schema}.settings WHERE key = 'disabled_jobs'), '{}')) AS off
       FROM ${schema}.jobs j LEFT JOIN ${schema}.job_runs r ON r.job = j.name AND r.started_at > $1 AND r.started_at <= $2
      GROUP BY j.name ORDER BY j.name`,
    [from, to],
  )
  return rows.map((r) => ({
    job: r.job,
    runs: r.runs,
    last: r.last && r.last.toISOString().slice(0, 16).replace('T', ' '),
    switchedOff: r.off,
    warn: r.runs === 0 && firedSince(parseSchedule(r.schedule), from, to, (to.getTime() - from.getTime()) / MINUTE) ? `no runs logged since ${from.toISOString().slice(0, 10)}${r.off ? ' (switched off)' : ''}` : null,
  }))
}
