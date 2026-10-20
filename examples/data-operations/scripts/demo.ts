// pnpm demo: seven parts, each BROKEN then GUARDED, against DATABASE_URL. Every part rebuilds
// the schemas it reads first. Timings are printed only as bounds ("under 1 s"), because the
// wall clock varies and the output must not.
import { connect, session, sleep } from '../src/db.ts'
import { compareAndSet, defaultsDiff, fixStatements } from '../src/defaults.ts'
import { drift, firstDifference, suspects } from '../src/drift.ts'
import { lastRuns, register, setupDispatch, tick, type Route } from '../src/dispatch.ts'
import { dryRun, drain, listen, receive, receiveInline, send, setupLanding, sign, sweepWait, teardownLanding } from '../src/landing.ts'
import { migrate, type Session } from '../src/migrate.ts'
import { RULES, reconcile } from '../src/reconcile.ts'
import { findStubs, visibleFilters } from '../src/stubs.ts'
import { cleanupWorkdirs, landingEvents, migrationsWorkdir, OPEN_DEALS_FIXED, seedApp, seedDeals, seedRevenue, seedSupport } from './generate.ts'

const pool = connect()
const c = await pool.connect()
const out = (s = '') => console.log(s)
const head = (s: string) => out(`\n=== ${s}`)
const count = async (sql: string) => (await c.query<{ n: number }>(sql)).rows[0]!.n
const bound = (ms: number) => [250, 500, 1000, 2000, 5000].find((b) => ms < b) ?? Infinity
const under = (ms: number) => `under ${bound(ms) >= 1000 ? `${bound(ms) / 1000} s` : `${bound(ms)} ms`}`

async function part1() {
  head('1. Edit after apply')
  const repo = migrationsWorkdir()
  await seedDeals(c, 'ops_live', repo.dir)
  const won = () => count(`SELECT count(*)::int AS n FROM ops_live.open_deals WHERE stage = 'won'`)
  out(`production ran 001-003. open_deals includes ${await won()} won deals (the bug).`)
  repo.commit('002-open-deals.sql', OPEN_DEALS_FIXED, 'open_deals: won deals are not open')
  out(`a reviewer edits 002 in place: WHERE d.stage NOT IN ('won', 'lost'); reviewed, merged, deployed.`)
  const deploy = await migrate(c, repo.dir, 'ops_live')
  out(`BROKEN   deploy: applied ${deploy.applied.length}, skipped ${deploy.skipped.length} (${deploy.skipped.join(', ')}): recorded by name, never re-run`)
  await seedDeals(c, 'ops_test', repo.dir)
  const testWon = await count(`SELECT count(*)::int AS n FROM ops_test.open_deals WHERE stage = 'won'`)
  out(`         test suite (fresh schema built from 001): open_deals has ${testWon} won deals -> ${testWon === 0 ? 'PASS' : 'FAIL'}`)
  out(`         production: open_deals still has ${await won()} won deals. Green suite, wrong production.`)
  const s = suspects(repo.dir)
  out(`GUARDED  pre-check, git log per file: ${s.map((x) => `${x.file} has ${x.commits} commits`).join('; ')} -> suspect`)
  const d = await drift(c, repo.dir, 'ops_live')
  out(`         drift (repo built into a scratch schema, pg_get_viewdef and function bodies compared): ${d.length} relation differs`)
  for (const x of d) {
    const [live, want] = firstDifference(x.live ?? '', x.repo ?? '')
    out(`           ${x.kind} ${x.name} ${x.status}\n             live: ...${live}...\n             repo: ...${want}...`)
  }
  repo.commit('004-open-deals-excludes-won.sql', OPEN_DEALS_FIXED, 're-issue open_deals under a new number')
  const fix = await migrate(c, repo.dir, 'ops_live')
  out(`         the fix is a new file: applied ${fix.applied.join(', ')}. production won deals: ${await won()}; drift now: ${(await drift(c, repo.dir, 'ops_live')).length} differ`)
  await c.query('DROP SCHEMA ops_test CASCADE')
}

async function part2() {
  head('2. NULL stubs')
  await seedSupport(c)
  const filters = ['status', 'priority', 'product_type']
  const rows = (await c.query('SELECT * FROM support.ticket_facts')).rows
  out(`tickets.product_type was added and filled after support.ticket_facts was written with NULL::text AS product_type.`)
  out(`BROKEN   the screen shows filters: ${visibleFilters(rows, filters).join(', ')}   (product_type hidden: every value is NULL, no error anywhere)`)
  const stubs = await findStubs(c, 'support')
  for (const s of stubs) out(`GUARDED  finding: ${s.view}.${s.column} is NULL::${s.type}, but ${s.source}.${s.column} exists (${s.filled} of ${s.rows} rows filled)`)
  out(`         not reported: ticket_facts.sentiment is also NULL::text, and no table it reads has a sentiment column`)
  await c.query('CREATE OR REPLACE VIEW support.ticket_facts AS SELECT id, status, priority, product_type, NULL::text AS sentiment FROM support.tickets')
  const after = (await c.query('SELECT * FROM support.ticket_facts')).rows
  out(`         after re-issuing the view: filters ${visibleFilters(after, filters).join(', ')}; findings now ${(await findStubs(c, 'support')).length}`)
}

async function part3() {
  head('3. Lost defaults')
  await seedApp(c)
  const nulls = await count('SELECT count(*)::int AS n FROM app_live.work_orders WHERE revision IS NULL')
  out(`a copy tool made app_live's tables; the baseline's ADD COLUMN IF NOT EXISTS then skipped every column it had made.`)
  out(`${nulls} work orders written since have revision NULL.`)
  await c.query(`UPDATE app_live.work_orders SET title = title WHERE id = 31`)
  const bumped = (await c.query('SELECT revision FROM app_live.work_orders WHERE id = 31')).rows[0]!.revision
  let won = 0
  for (let i = 0; i < 5; i++) if (await compareAndSet(c, 'app_live', 31, 'in_review')) won++
  out(`BROKEN   order 31: the bump trigger ran, revision is ${bumped} (NULL + 1); 5 compare-and-set writes, ${won} succeeded, ${5 - won} missed (each caller sees "changed under me")`)
  out(`         order 5 (copied with revision 1): compare-and-set ${(await compareAndSet(c, 'app_live', 5, 'in_review')) ? 'succeeded' : 'missed'}`)
  const gaps = await defaultsDiff(c, 'app_live')
  out(`GUARDED  baseline built into a scratch schema, information_schema.columns compared: ${gaps.length} gaps`)
  for (const g of gaps) out(`           ${g.table}.${g.column}: ${g.problem} (baseline: ${g.want.nullable ? 'NULL' : 'NOT NULL'}, default ${g.want.default ?? 'none'})`)
  const fixes = fixStatements('app_live', gaps)
  out(`         ${fixes.length} statements, backfill first, the bump trigger disabled around it (it would recompute NULL + 1):`)
  for (const f of fixes.filter((x) => x.includes('.work_orders') && x.includes('revision'))) out(`           ${f}`)
  out(`           ... (${fixes.length - 3} more for the other gaps)`)
  for (const f of fixes) await c.query(f)
  out(`         after: order 31 compare-and-set ${(await compareAndSet(c, 'app_live', 31, 'in_review')) ? 'succeeded' : 'missed'}; gaps now ${(await defaultsDiff(c, 'app_live')).length}`)
}

const describe = (s: Session[]) => (s.length ? s.map((x) => `${x.name} (${x.state}: ${x.query.slice(0, 40)})`).join(', ') : 'none')

async function part4() {
  head('4. Lock queue')
  const repo = migrationsWorkdir()
  await seedDeals(c, 'ops_busy', repo.dir)
  repo.commit('004-open-deals-excludes-won.sql', OPEN_DEALS_FIXED, 're-issue open_deals')
  const reader = 'SELECT count(*) FROM ops_busy.open_deals'
  // Hard caps on every connection, so the broken path ends on its own.
  const [longReader, runner, third, monitor] = [await session('m4-long-reader'), await session('m4-migration', 3000), await session('m4-reader-3', 1500), await session('m4-monitor')]
  try {
    out(`m4-long-reader opens a transaction and reads open_deals (an export that has not finished). Migration 004 redefines open_deals.`)
    await longReader.query('BEGIN')
    await longReader.query(reader)
    const naive = migrate(runner, repo.dir, 'ops_busy').catch((e: Error) => e)
    await sleep(300)
    const r3 = third.query(reader).then(
      () => 'answered',
      (e: { code?: string }) => (e.code === '57014' ? 'cancelled by its 1.5 s statement_timeout (57014)' : `failed (${e.code})`),
    )
    await sleep(500)
    const waiting = (
      await monitor.query<{ name: string }>(
        `SELECT application_name AS name FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name LIKE 'm4-%' ORDER BY 1`,
      )
    ).rows.map((r) => r.name)
    out(`BROKEN   no lock_timeout. pg_stat_activity, wait_event_type = 'Lock': ${waiting.join(', ')}`)
    out(`         m4-reader-3 is a plain SELECT. It waits behind the migration, not behind the long reader.`)
    out(`         m4-reader-3: ${await r3}, never granted its lock; without a cap it waits as long as the long reader lives`)
    const e = await naive
    const code = (e as { code?: string }).code
    out(`         migration: ${e instanceof Error ? (code === '57014' ? 'cancelled by the demo cap, 3 s statement_timeout (57014)' : `failed (${code})`) : 'applied'}`)
    await longReader.query('ROLLBACK')

    await longReader.query('BEGIN')
    await longReader.query(reader)
    const guarded = await session('m4-migration-guarded')
    const reader3 = await session('m4-reader-3', 5000)
    const lines: string[] = []
    const run = migrate(guarded, repo.dir, 'ops_busy', {
      lockTimeoutMs: 500,
      attempts: 4,
      backoffMs: 250,
      monitor,
      onRetry: async (attempt, err, seen) => {
        lines.push(`attempt ${attempt}: ${err.message}. held by: ${describe(seen.holders)}; queued behind it: ${describe(seen.queued)}`)
        if (attempt === 2) {
          await longReader.query('COMMIT')
          lines.push(`(the long reader finishes)`)
        }
      },
    })
    await sleep(100)
    const t1 = Date.now()
    await reader3.query(reader)
    const waited = Date.now() - t1
    const result = await run
    out(`GUARDED  BEGIN; SET LOCAL lock_timeout = '500ms'; up to 4 attempts, backoff 250 ms doubling`)
    for (const l of lines) out(`         ${l}`)
    out(`         attempt ${lines.length}: applied ${result.applied.join(', ')}`)
    out(`         m4-reader-3 answered ${waited < 1000 ? 'in under 1 s' : `after ${waited} ms`}: it waited for at most one lock_timeout, then went ahead of the retry`)
    await guarded.end()
    await reader3.end()

    await longReader.query('BEGIN')
    await longReader.query(reader)
    const failing = await session('m4-migration-guarded')
    repo.commit('005-open-deals-again.sql', OPEN_DEALS_FIXED, 'one more redefinition')
    const t2 = Date.now()
    const failed = await migrate(failing, repo.dir, 'ops_busy', { lockTimeoutMs: 500, attempts: 3, backoffMs: 250 }).catch((e: Error & { code?: string }) => e)
    out(`         if the reader never ends: ${failed instanceof Error ? `${(failed as { code?: string }).code} ${failed.message} after 3 attempts, ${under(Date.now() - t2)}; each attempt held the queue for at most its 500 ms, and the deploy fails` : 'applied'}`)
    await longReader.query('ROLLBACK')
    await failing.end()
  } finally {
    for (const s of [longReader, runner, third, monitor]) await s.end().catch(() => {})
  }
}

async function part5() {
  head('5. Event landing')
  const { createdRole } = await setupLanding(c)
  const secret = 'demo-signing-secret'
  const events = landingEvents()
  const delivery = (e: (typeof events)[number]) => {
    const body = JSON.stringify({ event_id: e.event_id, account: e.account, action: e.action })
    return { body, signature: sign(secret, body) }
  }
  const first = events[0]!
  const inline = await send(() => receiveInline(pool, secret, delivery(first), 300), 100, 3)
  await inline.settled
  const inlineRuns = await count(`SELECT count(*)::int AS n FROM landing.inline_effects WHERE event_id = '${first.event_id}'`)
  out(`BROKEN   receiver does the work inline (300 ms); the sender waits 100 ms, then retries, 3 attempts.`)
  out(`         ${first.event_id}: ${inline.attempts} deliveries, the work ran ${inlineRuns} times`)

  const writer = await session('landing-receiver')
  const stored = await send(() => receive(writer, secret, delivery(first)), 100, 3)
  const again = await receive(writer, secret, delivery(first))
  const forged = await receive(writer, secret, { ...delivery(first), signature: sign('wrong', delivery(first).body) })
  out(`GUARDED  store-then-ack: ${first.event_id} answered on attempt ${stored.attempts}; a redelivery -> ${again}; a bad signature -> ${forged}; rows stored: ${await count('SELECT count(*)::int AS n FROM landing.events')}`)
  await writer.query('SET ROLE acme_ops_landing_writer')
  const denied = await writer.query('SELECT count(*) FROM landing.events').then(() => 'allowed', (e: Error) => e.message)
  await writer.query('RESET ROLE')
  const by = (await c.query<{ by: string }>('SELECT min(stored_by) AS by FROM landing.events')).rows[0]!.by
  out(`         stored by role ${by}; that role reading the table: ${denied}`)

  const handledAt = new Map<string, number>()
  const stop = await listen(pool, (ids) => ids.forEach((id) => handledAt.set(id, Date.now())))
  await sleep(100) // the backlog: the first event was stored before anyone listened
  await drain(pool)
  const sent = new Map<string, number>()
  for (const e of events.slice(1)) {
    sent.set(e.event_id, Date.now())
    await receive(writer, secret, delivery(e))
  }
  for (let i = 0; i < 50 && events.slice(1).some((e) => !handledAt.has(e.event_id)); i++) await sleep(20)
  await stop()
  const notifyMs = Math.max(...events.slice(1).map((e) => handledAt.get(e.event_id)! - sent.get(e.event_id)!))
  const sweepMs = events.slice(1).map((e) => sweepWait(e.landsAtMs, 60_000)).sort((a, b) => a - b)
  out(`         4 more events. Sweep-only, every 60 s (computed from where each lands in the minute): handled ${sweepMs.join(', ')} ms after landing; worst case 60000`)
  out(`         notify on insert (measured): every event handled ${under(notifyMs)} after it was stored`)
  const effects = () => count('SELECT count(*)::int AS n FROM landing.effects')
  const before = await effects()
  await c.query('UPDATE landing.events SET handled = false')
  const replayed = await drain(pool)
  out(`         replay (handled = false on all ${replayed.length}, drained again): effects ${before} -> ${await effects()}`)
  await receive(writer, secret, delivery({ ...first, event_id: 'evt_2001', action: 'reply' }))
  const id = (await c.query<{ id: number }>(`SELECT id FROM landing.events WHERE event_id = 'evt_2001'`)).rows[0]!.id
  const dry = await dryRun(pool, id)
  const stillOpen = await count(`SELECT count(*)::int AS n FROM landing.events WHERE event_id = 'evt_2001' AND NOT handled`)
  out(`         dry run of evt_2001: would write ${dry.wouldWrite} effect (${dry.event?.action} for ${dry.event?.account}); effects still ${await effects()}, event still unhandled: ${stillOpen === 1}`)
  await writer.end()
  // The role is cluster-wide; leave nothing behind that this run made.
  await teardownLanding(c, createdRole)
}

const DAY = 86_400_000
const START = Date.parse('2026-06-15T00:00:00Z') // a Monday

async function simulate(schema: string, routes: Record<string, Route>, days: number) {
  for (let t = START + 30 * 60_000; t <= START + days * DAY; t += 30 * 60_000) await tick(c, schema, routes, new Date(t))
}

async function part6() {
  head('6. One schedule, many jobs')
  const synced = (s: string) => count(`SELECT count(*)::int AS n FROM ${s}.work WHERE what = 'sync'`)
  const deduped = (s: string) => count(`SELECT count(*)::int AS n FROM ${s}.work WHERE what = 'dedupe'`)
  const setup = async (s: string, off: string[]) => {
    await setupDispatch(c, s)
    await c.query(`CREATE TABLE ${s}.work (what text, at timestamptz)`)
    await c.query(`INSERT INTO ${s}.settings VALUES ('disabled_jobs', $1)`, [off])
  }
  const doWork = (s: string, what: string): Route => async ({ at }) => void (await c.query(`INSERT INTO ${s}.work VALUES ($1, $2)`, [what, at]))
  const isOff = async (s: string, job: string) => (await c.query(`SELECT $1 = ANY(value) AS off FROM ${s}.settings WHERE key = 'disabled_jobs'`, [job])).rows[0]!.off

  // The route as it was written for the old host: its own switch turns off only the optional half.
  const brokenRoutes = (s: string): Record<string, Route> => ({
    'crm-sync': async (ctx) => {
      await doWork(s, 'sync')(ctx)
      if (await isOff(s, 'crm-sync')) return ctx.log('duplicate detection skipped: switched off')
      await doWork(s, 'dedupe')(ctx)
    },
    'nightly-rollup': doWork(s, 'rollup'),
  })
  const jobs = { 'crm-sync': '0 6 *', 'nightly-rollup': '30 2 *' }
  out(`someone switches off "crm-sync" on the jobs screen, whose label says "duplicate detection (does not stop the sync)".`)
  await setup('sched_old', ['crm-sync'])
  for (let d = 0; d < 14; d++) await brokenRoutes('sched_old')['crm-sync']!({ at: new Date(START + d * DAY + 6 * 3600_000), log: () => {} })
  out(`BROKEN   old host (calls every route on its schedule; the route reads the switch): 14 days, sync ${await synced('sched_old')} runs, dedupe ${await deduped('sched_old')}`)
  await setup('sched', ['crm-sync'])
  await register(c, 'sched', brokenRoutes('sched'), jobs, new Date(START))
  await simulate('sched', brokenRoutes('sched'), 14)
  out(`         new host (one schedule; dispatcher ticks every 30 min, skips switched-off names): 14 days, sync ${await synced('sched')} runs, dedupe ${await deduped('sched')}`)
  for (const r of await lastRuns(c, 'sched', new Date(START), new Date(START + 14 * DAY)))
    out(`           ${r.job.padEnd(15)} runs ${String(r.runs).padStart(2)}  last ${r.last ?? '-'.padEnd(16)}  ${r.warn ? `WARN ${r.warn}` : ''}`.trimEnd())

  const guardedRoutes = (s: string): Record<string, Route> => ({ 'crm-sync': doWork(s, 'sync'), 'crm-dedupe': doWork(s, 'dedupe'), 'nightly-rollup': doWork(s, 'rollup') })
  await setup('sched', ['crm-dedupe'])
  await register(c, 'sched', guardedRoutes('sched'), { ...jobs, 'crm-dedupe': '15 6 *' }, new Date(START))
  await simulate('sched', guardedRoutes('sched'), 14)
  out(`GUARDED  duplicate detection is its own job, crm-dedupe, and that is the name switched off. 14 days: sync ${await synced('sched')} runs, dedupe ${await deduped('sched')}`)
  for (const r of await lastRuns(c, 'sched', new Date(START), new Date(START + 14 * DAY)))
    out(`           ${r.job.padEnd(15)} runs ${String(r.runs).padStart(2)}  last ${r.last ?? '-'.padEnd(16)}  ${r.warn ? `WARN ${r.warn}` : ''}`.trimEnd())
  await c.query(`DELETE FROM sched.settings`)
  const t = await tick(c, 'sched', guardedRoutes('sched'), new Date(START + 15 * DAY + 6 * 3600_000))
  out(`         the switch row missing at a tick where crm-sync is due: ran ${t.ran.length}; ${t.standDown}`)
  await c.query('DROP SCHEMA sched_old CASCADE')
}

async function part7() {
  head('7. Reconciliation')
  await seedRevenue(c)
  const r = await reconcile(c, 'rev')
  const names = (rules: (keyof typeof RULES)[]) => (rules.length ? rules.map((x) => RULES[x].says).join(' + ') : 'no rules')
  out(`ledger rebuilt from ${await count('SELECT count(*)::int AS n FROM rev.deal_events')} deal events; finance workbook has ${r.dealDays.total} rows. New and expansion, per quarter:`)
  for (const s of r.steps) out(`  ${names(s.rules).padEnd(70)} ${s.matched} of ${s.quarters} quarters match exactly`)
  out(`BROKEN   with no rules, the two disagree in ${r.steps[0]!.quarters - r.steps[0]!.matched} quarters and nothing says why.`)
  out(`GUARDED  both rules, deal by deal: ${r.dealDays.matched} of ${r.dealDays.total} workbook rows match a ledger row exactly.`)
  for (const q of r.quarters.filter((x) => !x.match))
    out(`           ${q.quarter}: new ${q.ledger_new} vs ${q.book_new}, expansion ${q.ledger_expansion} vs ${q.book_expansion}`)
  for (const x of r.residual) out(`           ${x.deal_id} ${x.booked_on} ${x.category.padEnd(9)} workbook ${x.book}, ledger ${x.ledger ?? '-'}: ${x.cause}`)
  const last = r.steps[r.steps.length - 1]!
  out(`         ${last.matched} of ${last.quarters} quarters match exactly; residual ${r.residualTotal} traced to ${r.residual.length} rows`)
}

const parts = [part1, part2, part3, part4, part5, part6, part7]
const only = process.argv[2] ? [parts[Number(process.argv[2]) - 1]!] : parts
try {
  for (const p of only) await p()
} finally {
  cleanupWorkdirs()
  c.release()
  await pool.end()
}
