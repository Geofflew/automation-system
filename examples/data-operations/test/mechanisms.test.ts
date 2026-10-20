// One file, run in order, against DATABASE_URL. Every schema here starts with t_, so the tests
// do not touch what the demo built.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupWorkdirs, landingEvents, migrationsWorkdir, OPEN_DEALS_FIXED, seedApp, seedDeals, seedRevenue, seedSupport } from '../scripts/generate.ts'
import { connect, session, sleep } from '../src/db.ts'
import { compareAndSet, defaultsDiff, fixStatements } from '../src/defaults.ts'
import { drift, suspects } from '../src/drift.ts'
import { firedSince, lastRuns, parseSchedule, register, setupDispatch, tick, type Route } from '../src/dispatch.ts'
import { drain, dryRun, listen, receive, setupLanding, sign, teardownLanding, WRITER_ROLE } from '../src/landing.ts'
import { migrate, type Seen } from '../src/migrate.ts'
import { reconcile } from '../src/reconcile.ts'
import { findStubs } from '../src/stubs.ts'

const pool = connect()
let c: pg.PoolClient
const one = async <T>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0] as T

beforeAll(async () => {
  c = await pool.connect()
})
afterAll(async () => {
  for (const s of ['t_live', 't_fresh', 't_busy', 't_support', 't_app', 't_landing', 't_sched', 't_rev', 't_raw', 't_sem']) await c.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`)
  cleanupWorkdirs()
  c.release()
  await pool.end()
})

describe('1 edit after apply', () => {
  it('the runner skips an edited applied file, so live and a fresh build disagree', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_live', repo.dir)
    repo.commit('002-open-deals.sql', OPEN_DEALS_FIXED, 'edit')
    expect((await migrate(c, repo.dir, 't_live')).applied).toEqual([])
    await seedDeals(c, 't_fresh', repo.dir)
    const won = (s: string) => one<{ n: number }>(`SELECT count(*)::int AS n FROM ${s}.open_deals WHERE stage = 'won'`)
    expect((await won('t_fresh')).n).toBe(0)
    expect((await won('t_live')).n).toBeGreaterThan(0)
  })

  it('drift names the edited view and the edited function, and nothing else', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_live', repo.dir)
    expect(await drift(c, repo.dir, 't_live')).toEqual([])
    repo.commit('002-open-deals.sql', OPEN_DEALS_FIXED, 'edit view')
    const fn = readFileSync(join(repo.dir, '003-deal-size.sql'), 'utf8').replace('>= 5000', '>= 6000')
    repo.commit('003-deal-size.sql', fn, 'edit function')
    const d = await drift(c, repo.dir, 't_live')
    expect(d.map((x) => [x.kind, x.name, x.status])).toEqual([
      ['function', 'deal_size(amount numeric)', 'differs'],
      ['view', 'open_deals', 'differs'],
    ])
    expect(suspects(repo.dir).map((s) => s.file)).toEqual(['002-open-deals.sql', '003-deal-size.sql'])
  })

  it('a function that differs only inside a string literal is drift', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_live', repo.dir)
    const label = (s: string) => `CREATE FUNCTION label() RETURNS text LANGUAGE sql AS $$ SELECT '${s}' $$;`
    repo.commit('004-label.sql', label('a b'), 'add label')
    await migrate(c, repo.dir, 't_live')
    expect(await drift(c, repo.dir, 't_live')).toEqual([])
    repo.commit('004-label.sql', label('a  b'), 'edit label')
    expect((await drift(c, repo.dir, 't_live')).map((x) => [x.name, x.status])).toEqual([['label()', 'differs']])
  })

  it('a re-issuing migration under a new number clears the drift', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_live', repo.dir)
    repo.commit('002-open-deals.sql', OPEN_DEALS_FIXED, 'edit')
    repo.commit('004-open-deals-again.sql', OPEN_DEALS_FIXED, 're-issue')
    await migrate(c, repo.dir, 't_live')
    expect(await drift(c, repo.dir, 't_live')).toEqual([])
  })
})

describe('2 NULL stubs', () => {
  it('reports a stub whose column now exists on a source table, not one with no source', async () => {
    await seedSupport(c, 't_support')
    const s = await findStubs(c, 't_support')
    expect(s).toEqual([{ view: 'ticket_facts', column: 'product_type', type: 'text', source: 't_support.tickets', filled: 240, rows: 240 }])
    await c.query('CREATE OR REPLACE VIEW t_support.ticket_facts AS SELECT id, status, priority, product_type, NULL::text AS sentiment FROM t_support.tickets')
    expect(await findStubs(c, 't_support')).toEqual([])
  })

  it('finds a stub whose source table is in another schema', async () => {
    await c.query('DROP SCHEMA IF EXISTS t_raw CASCADE; DROP SCHEMA IF EXISTS t_sem CASCADE; CREATE SCHEMA t_raw; CREATE SCHEMA t_sem')
    await c.query(`CREATE TABLE t_raw.tickets (id int, product_type text); INSERT INTO t_raw.tickets VALUES (1, 'close'), (2, NULL), (3, 'flux')`)
    await c.query('CREATE VIEW t_sem.ticket_facts AS SELECT id, NULL::text AS product_type FROM t_raw.tickets')
    expect(await findStubs(c, 't_sem')).toEqual([{ view: 'ticket_facts', column: 'product_type', type: 'text', source: 't_raw.tickets', filled: 2, rows: 3 }])
  })

  it('reads multi-word types and types with modifiers', async () => {
    await c.query('ALTER TABLE t_support.tickets ADD COLUMN closed_at timestamptz, ADD COLUMN region varchar(40), ADD COLUMN score numeric(12,2)')
    await c.query(`CREATE VIEW t_support.closed AS SELECT id, NULL::timestamp with time zone AS closed_at,
      NULL::varchar(40) AS region, NULL::numeric(12,2) AS score FROM t_support.tickets`)
    expect((await findStubs(c, 't_support')).map((s) => [s.view, s.column, s.type])).toEqual([
      ['closed', 'closed_at', 'timestamp with time zone'],
      ['closed', 'region', 'character varying(40)'],
      ['closed', 'score', 'numeric(12,2)'],
    ])
  })
})

describe('3 lost defaults', () => {
  it('compare-and-set misses on a NULL revision; the diff and its statements fix it', async () => {
    await seedApp(c, 't_app')
    expect(await compareAndSet(c, 't_app', 31, 'in_review')).toBe(false)
    const gaps = await defaultsDiff(c, 't_app')
    expect(gaps.map((g) => `${g.table}.${g.column}:${g.problem}`)).toEqual([
      'usage_events.batch:no_default',
      'usage_events.kind:nullable',
      'work_orders.phase:no_default',
      'work_orders.revision:no_default',
      'work_orders.title:nullable',
    ])
    for (const f of fixStatements('t_app', gaps)) await c.query(f)
    expect(await defaultsDiff(c, 't_app')).toEqual([])
    expect(await compareAndSet(c, 't_app', 31, 'in_review')).toBe(true)
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM t_app.work_orders WHERE revision IS NULL')).toEqual({ n: 0 })
  })

  it('a backfill with the bump trigger enabled is undone by it', async () => {
    await seedApp(c, 't_app')
    await c.query('UPDATE t_app.work_orders SET revision = 0 WHERE revision IS NULL')
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM t_app.work_orders WHERE revision IS NULL')).n).toBe(8)
    const gap = (await defaultsDiff(c, 't_app')).find((g) => g.column === 'revision')!
    expect(fixStatements('t_app', [gap])[0]).toMatch(/DISABLE TRIGGER USER; UPDATE .* ENABLE TRIGGER USER;/)
  })
})

describe('4 lock queue', () => {
  it('the guarded runner gives up within its timeout and a reader behind it is not held', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_busy', repo.dir)
    repo.commit('004-open-deals-again.sql', OPEN_DEALS_FIXED, 're-issue')
    const [holder, runner, reader, monitor] = [await session('t4-holder'), await session('t4-runner', 3000), await session('t4-reader', 1500), await session('t4-monitor')]
    const seen: Seen[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT count(*) FROM t_busy.open_deals')
      const t0 = Date.now()
      const run = migrate(runner, repo.dir, 't_busy', { lockTimeoutMs: 300, attempts: 2, backoffMs: 100, monitor, onRetry: (_a, _e, s) => void seen.push(s) }).then(
        () => 'applied',
        (e: { code?: string }) => e.code,
      )
      await sleep(100)
      await reader.query('SELECT count(*) FROM t_busy.open_deals') // would hit its 1.5 s cap if the runner held the queue
      expect(await run).toBe('55P03')
      expect(Date.now() - t0).toBeLessThan(2000)
      // The first attempt saw who held its lock and who queued behind it.
      expect(seen[0]!.holders.map((s) => [s.name, s.state])).toEqual([['t4-holder', 'idle in transaction']])
      expect(seen[0]!.queued.map((s) => s.name)).toEqual(['t4-reader'])
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM t_busy.migrations WHERE name LIKE '004%'`)).n).toBe(0)
      await holder.query('COMMIT')
      expect((await migrate(runner, repo.dir, 't_busy', { lockTimeoutMs: 300 })).applied).toEqual(['004-open-deals-again.sql'])
    } finally {
      for (const s of [holder, runner, reader, monitor]) await s.end()
    }
  })

  it('without a lock_timeout the same reader is blocked behind the migration', async () => {
    const repo = migrationsWorkdir()
    await seedDeals(c, 't_busy', repo.dir)
    repo.commit('004-open-deals-again.sql', OPEN_DEALS_FIXED, 're-issue')
    const [holder, runner, reader] = [await session('t4-holder'), await session('t4-runner', 2000), await session('t4-reader', 800)]
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT count(*) FROM t_busy.open_deals')
      const run = migrate(runner, repo.dir, 't_busy').catch((e: { code?: string }) => e.code)
      await sleep(100)
      await expect(reader.query('SELECT count(*) FROM t_busy.open_deals')).rejects.toMatchObject({ code: '57014' })
      await holder.query('ROLLBACK')
      await run
    } finally {
      for (const s of [holder, runner, reader]) await s.end()
    }
  })
})

describe('5 event landing', () => {
  const secret = 'test-secret'
  const deliver = (event_id: string) => {
    const body = JSON.stringify({ event_id, account: 'Amber Pine Co', action: 'mention' })
    return { body, signature: sign(secret, body) }
  }

  let createdRole = false
  afterAll(async () => teardownLanding(c, createdRole, 't_landing'))

  it('stores once per event id, refuses a bad signature, and the writer cannot read', async () => {
    createdRole = (await setupLanding(c, 't_landing')).createdRole
    const w = await session('t5-writer')
    try {
      expect(await receive(w, secret, deliver('e1'), 't_landing')).toBe(200)
      expect(await receive(w, secret, deliver('e1'), 't_landing')).toBe(200)
      expect(await receive(w, secret, { ...deliver('e2'), signature: 'x' }, 't_landing')).toBe(401)
      expect(await one('SELECT count(*)::int AS n, min(stored_by) AS by FROM t_landing.events')).toEqual({ n: 1, by: WRITER_ROLE })
      await w.query(`SET ROLE ${WRITER_ROLE}`)
      await expect(w.query('SELECT * FROM t_landing.events')).rejects.toThrow(/permission denied/)
      await expect(w.query('DELETE FROM t_landing.events')).rejects.toThrow(/permission denied/)
    } finally {
      await w.end()
    }
  })

  it('a replay changes nothing, a dry run writes nothing, and notify drains with no sweep', async () => {
    expect(await drain(pool, undefined, 't_landing')).toEqual(['e1'])
    await c.query('UPDATE t_landing.events SET handled = false')
    expect(await drain(pool, undefined, 't_landing')).toEqual(['e1'])
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM t_landing.effects')).toEqual({ n: 1 })

    const handled: string[] = []
    const stop = await listen(pool, (ids) => void handled.push(...ids), 't_landing')
    const w = await session('t5-writer')
    try {
      for (const e of landingEvents()) await receive(w, secret, deliver(e.event_id), 't_landing')
      for (let i = 0; i < 50 && handled.length < 5; i++) await sleep(20)
      expect(handled.sort()).toEqual(landingEvents().map((e) => e.event_id))
      await stop()
      await receive(w, secret, deliver('e9'), 't_landing')
      const { id } = await one<{ id: number }>(`SELECT id FROM t_landing.events WHERE event_id = 'e9'`)
      expect((await dryRun(pool, id, 't_landing')).wouldWrite).toBe(1)
      expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM t_landing.effects')).toEqual({ n: 6 })
      expect(await one<{ handled: boolean }>(`SELECT handled FROM t_landing.events WHERE id = $1`, [id])).toEqual({ handled: false })
    } finally {
      await w.end()
    }
  })

  it('a notification that arrives during a drain gets one more pass', async () => {
    await c.query('UPDATE t_landing.events SET handled = true')
    const w = await session('t5-writer')
    const passes: string[][] = []
    // The callback runs while the first pass still counts as running: an event stored now, and
    // its notification, land mid-drain. Without the "again" flag it would wait for a sweep.
    const stop = await listen(pool, async (ids) => {
      passes.push(ids)
      if (passes.length === 1) {
        await receive(w, secret, deliver('late'), 't_landing')
        await sleep(100)
      }
    }, 't_landing')
    try {
      await receive(w, secret, deliver('first'), 't_landing')
      for (let i = 0; i < 50 && !passes.flat().includes('late'); i++) await sleep(20)
      expect(passes.slice(0, 2)).toEqual([['first'], ['late']])
    } finally {
      await stop()
      await w.end()
    }
  })
})

describe('6 dispatcher', () => {
  const at = (iso: string) => new Date(`${iso}Z`)

  it('reads three-field schedules and refuses what it cannot read', () => {
    const m = parseSchedule('*/15 6-8 1,3')
    expect(m(at('2026-06-15T06:45:00'))).toBe(true) // Monday
    expect(m(at('2026-06-16T06:45:00'))).toBe(false) // Tuesday
    expect(m(at('2026-06-15T09:00:00'))).toBe(false)
    expect(() => parseSchedule('0 6 * *')).toThrow(/3 fields/)
    expect(() => parseSchedule('0 25 *')).toThrow(/out of range/)
    expect(() => parseSchedule('0 six *')).toThrow(/cannot read/)
  })

  it('a tick that runs late still starts a job whose minute it missed', () => {
    const m = parseSchedule('0 6 *')
    expect(firedSince(m, at('2026-06-15T05:30:00'), at('2026-06-15T06:07:00'))).toBe(true)
    expect(firedSince(m, at('2026-06-15T06:00:00'), at('2026-06-15T06:30:00'))).toBe(false)
  })

  const setup = async (off: string[] | null, routes: Record<string, Route>, jobs: Record<string, string>) => {
    await setupDispatch(c, 't_sched')
    await c.query('CREATE TABLE t_sched.work (what text)')
    if (off) await c.query(`INSERT INTO t_sched.settings VALUES ('disabled_jobs', $1)`, [off])
    await register(c, 't_sched', routes, jobs, at('2026-06-15T00:00:00'))
  }
  const work = (what: string): Route => async () => void (await c.query('INSERT INTO t_sched.work VALUES ($1)', [what]))
  const days = async (n: number, routes: Record<string, Route>) => {
    for (let t = Date.parse('2026-06-15T00:30:00Z'); t <= Date.parse('2026-06-15T00:00:00Z') + n * 86_400_000; t += 30 * 60_000) await tick(c, 't_sched', routes, new Date(t))
  }

  it('the optional half as its own job: switching it off leaves the required sync running', async () => {
    const routes = { 'crm-sync': work('sync'), 'crm-dedupe': work('dedupe') }
    await setup(['crm-dedupe'], routes, { 'crm-sync': '0 6 *', 'crm-dedupe': '15 6 *' })
    await days(14, routes)
    expect(await one<{ n: number }>(`SELECT count(*)::int AS n FROM t_sched.work WHERE what = 'sync'`)).toEqual({ n: 14 })
    const report = await lastRuns(c, 't_sched', at('2026-06-15T00:00:00'), at('2026-06-29T00:00:00'))
    expect(report.map((r) => [r.job, r.runs, r.warn])).toEqual([
      ['crm-dedupe', 0, 'no runs logged since 2026-06-15 (switched off)'],
      ['crm-sync', 14, null],
    ])
  })

  it('a missing switch row runs nothing, and a broken read runs nothing', async () => {
    const routes = { 'crm-sync': work('sync') }
    await setup(null, routes, { 'crm-sync': '0 6 *' })
    const r = await tick(c, 't_sched', routes, at('2026-06-15T06:00:00'))
    expect([r.ran, r.standDown]).toEqual([[], 'no disabled_jobs row; running nothing until one exists'])
    await c.query('DROP TABLE t_sched.settings')
    expect((await tick(c, 't_sched', routes, at('2026-06-15T06:00:00'))).standDown).toMatch(/cannot read/)
  })
})

describe('7 reconciliation', () => {
  it('rules close the gap one at a time and the residual traces to the orphan deals', async () => {
    await seedRevenue(c, 't_rev')
    const r = await reconcile(c, 't_rev')
    expect(r.steps.map((s) => s.matched)).toEqual([1, 4, 10])
    expect(r.residual).toHaveLength(6)
    expect(new Set(r.residual.map((x) => x.cause))).toEqual(new Set(['deal has no company link; the ledger reads deals through companies']))
    expect(r.residualTotal).toBe(22750)
    expect(r.dealDays).toEqual({ matched: 174, total: 180 })
  })

  it('an amount that differs is traced as one, not as an orphan', async () => {
    await c.query(`UPDATE t_rev.workbook SET amount = amount + 50 WHERE (deal_id, booked_on) = (SELECT deal_id, min(booked_on) FROM t_rev.workbook WHERE deal_id = 'D-0001' GROUP BY 1)`)
    const r = await reconcile(c, 't_rev')
    expect(r.residual.filter((x) => x.deal_id === 'D-0001').map((x) => x.cause)).toEqual(['amounts differ'])
  })
})
