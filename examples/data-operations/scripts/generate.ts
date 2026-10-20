// Builds every schema the demo reads, from a fixed seed and a fixed anchor date, so every run
// prints the same numbers. `pnpm generate` builds all of them; the demo rebuilds each part's
// schema before that part, so parts can be run in any order and twice.
import type pg from 'pg'
import { connect } from '../src/db.ts'
import { baselineFile } from '../src/defaults.ts'
import { migrationsDir } from '../src/drift.ts'
import { migrate } from '../src/migrate.ts'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ANCHOR = '2026-07-01'
const SEED = 20260701

function rng(seed: number) {
  let a = seed
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! }
}

const ADJ = ['Amber', 'Cobalt', 'Granite', 'Hollow', 'Ember', 'Copper', 'Willow', 'Silver', 'Quiet', 'North', 'Bright', 'Juniper'] as const
const NOUN = ['Harbor', 'Pine', 'Canyon', 'Ledger', 'Meadow', 'Lantern', 'Ridge', 'Brook', 'Field', 'Summit'] as const
const SUFFIX = ['Works', 'Group', 'Co', 'Labs', 'Partners'] as const

export function companyNames(n: number, seed = SEED): string[] {
  const r = rng(seed)
  const seen = new Set<string>()
  while (seen.size < n) seen.add(`${r.pick(ADJ)} ${r.pick(NOUN)} ${r.pick(SUFFIX)}`)
  return [...seen]
}

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10)

/** Parts 1 and 4: the migrations as first shipped, plus 20 companies and 60 deals. */
export async function seedDeals(db: pg.ClientBase, schema: string, dir = migrationsDir): Promise<void> {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await migrate(db, dir, schema)
  const r = rng(SEED + 1)
  const names = companyNames(20)
  for (const [i, name] of names.entries()) await db.query(`INSERT INTO ${schema}.companies VALUES ($1, $2)`, [i + 1, name])
  const stages = ['qualify', 'proposal', 'negotiate', 'won', 'lost'] as const
  for (let id = 1; id <= 60; id++)
    await db.query(`INSERT INTO ${schema}.deals VALUES ($1, $2, $3, $4)`, [id, r.int(1, 20), stages[id % 5], r.int(5, 120) * 50])
}

/**
 * Parts 1 and 4: a throwaway copy of migrations/ in its own git repository, so the demo can edit
 * an applied file and commit the edit without touching this repo. `commit` writes a file and
 * commits it, the way a reviewed change lands.
 */
const workdirs: string[] = []

/** Removes every workdir this process made. Demo and tests call it in a finally. */
export function cleanupWorkdirs(): void {
  for (const d of workdirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function migrationsWorkdir(): { dir: string; commit: (file: string, sql: string, message: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'acme-migrations-'))
  workdirs.push(dir)
  cpSync(migrationsDir, dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'migrations as shipped')
  return {
    dir,
    commit: (file, sql, message) => {
      writeFileSync(join(dir, file), sql)
      git('add', file)
      git('commit', '-qm', message)
    },
  }
}

/** The edit a reviewer makes to 002 after it shipped: won deals are not open. */
export const OPEN_DEALS_FIXED = readFileSync(join(migrationsDir, '002-open-deals.sql'), 'utf8')
  .replace("WHERE d.stage <> 'lost'", "WHERE d.stage NOT IN ('won', 'lost')")
  .replace('CREATE VIEW', 'CREATE OR REPLACE VIEW')

/**
 * Part 2. The view was written while tickets had no product_type, so it stubs the column. The
 * column arrives later and the sync fills every row; the view is never touched again. A second
 * stub, `sentiment`, has no source column anywhere and is deliberate.
 */
export async function seedSupport(db: pg.ClientBase, schema = 'support'): Promise<void> {
  const r = rng(SEED + 2)
  await db.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.tickets (id int PRIMARY KEY, status text NOT NULL, priority text NOT NULL);
    CREATE VIEW ${schema}.ticket_facts AS
      SELECT id, status, priority, NULL::text AS product_type, NULL::text AS sentiment FROM ${schema}.tickets;
  `)
  for (let id = 1; id <= 240; id++)
    await db.query(`INSERT INTO ${schema}.tickets VALUES ($1, $2, $3)`, [id, r.pick(['open', 'pending', 'closed']), r.pick(['low', 'normal', 'high'])])
  await db.query(`ALTER TABLE ${schema}.tickets ADD COLUMN product_type text`)
  await db.query(`UPDATE ${schema}.tickets SET product_type = (ARRAY['reporting', 'connectors', 'billing', 'api'])[1 + id % 4]`)
}

/**
 * Part 3. A copy tool made both tables from the old database's columns, with no defaults and
 * no NOT NULL, and copied 30 work orders across with their revisions. Then the baseline ran:
 * every ADD COLUMN for a column the copy already made was skipped. Then the app wrote 8 new
 * work orders and 5 usage events, relying on defaults that are not there.
 */
export async function seedApp(db: pg.ClientBase, schema = 'app_live'): Promise<void> {
  await db.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.work_orders (id int PRIMARY KEY, title text, revision int, phase text);
    CREATE TABLE ${schema}.usage_events (id int PRIMARY KEY, kind text, batch text);
  `)
  for (let id = 1; id <= 30; id++)
    await db.query(`INSERT INTO ${schema}.work_orders VALUES ($1, $2, $3, 'open')`, [id, `Order ${id}`, id % 4])
  await db.query(`SET search_path = ${schema}`)
  await db.query(readFileSync(baselineFile, 'utf8'))
  await db.query('RESET search_path')
  for (let id = 31; id <= 38; id++) await db.query(`INSERT INTO ${schema}.work_orders (id, title) VALUES ($1, $2)`, [id, `Order ${id}`])
  for (let id = 1; id <= 5; id++) await db.query(`INSERT INTO ${schema}.usage_events (id, kind) VALUES ($1, 'export')`, [id])
}

/**
 * Part 5. Five events, each with when it lands in the sweep's minute (ms after the last sweep).
 * The offsets are what a once-a-minute sweep turns into waiting.
 */
export function landingEvents(): { event_id: string; account: string; action: string; landsAtMs: number }[] {
  const r = rng(SEED + 5)
  const names = companyNames(5, SEED + 5)
  return names.map((account, i) => ({ event_id: `evt_${1001 + i}`, account, action: r.pick(['mention', 'reply', 'card_click']), landsAtMs: r.int(1, 59) * 1000 + 500 }))
}

/**
 * Part 7. 140 deals over 12 quarters ending the quarter before the anchor. One deal in five is
 * on the services line; one first booking in eight is a win-back; four in ten deals expand once.
 * Six deals in the last two quarters have no company link. The workbook is written deal by deal
 * with its own two rules, and it keeps the six.
 */
export async function seedRevenue(db: pg.ClientBase, schema = 'rev'): Promise<void> {
  const r = rng(SEED + 7)
  await db.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.companies (id int PRIMARY KEY, name text NOT NULL);
    CREATE TABLE ${schema}.deals (id text PRIMARY KEY, company_id int, product_line text NOT NULL);
    CREATE TABLE ${schema}.deal_events (deal_id text NOT NULL REFERENCES ${schema}.deals, occurred_on date NOT NULL,
      kind text NOT NULL CHECK (kind IN ('new', 'expansion', 'winback')), amount numeric(12, 2) NOT NULL);
    CREATE TABLE ${schema}.workbook (deal_id text NOT NULL, booked_on date NOT NULL,
      category text NOT NULL CHECK (category IN ('new', 'expansion')), amount numeric(12, 2) NOT NULL);
    -- The ledger: bookings per deal per day, read through the company, the way every report
    -- groups them. It keeps win-backs and the services line as their own categories.
    CREATE VIEW ${schema}.ledger AS
      SELECT e.deal_id, e.occurred_on AS booked_on, c.name AS company,
             CASE WHEN d.product_line = 'services' THEN 'services' WHEN e.kind = 'winback' THEN 'winback' ELSE e.kind END AS category,
             e.amount
        FROM ${schema}.deal_events e
        JOIN ${schema}.deals d ON d.id = e.deal_id
        JOIN ${schema}.companies c ON c.id = d.company_id;
  `)
  const names = companyNames(90, SEED + 7)
  for (const [i, name] of names.entries()) await db.query(`INSERT INTO ${schema}.companies VALUES ($1, $2)`, [i + 1, name])
  const start = '2023-07-01' // 12 quarters: 2023-Q3 to 2026-Q2
  const span = (Date.parse(ANCHOR) - Date.parse(start)) / 86_400_000
  const orphanDays = [span - 170, span - 150, span - 120, span - 95, span - 60, span - 20] // 2026-Q1 x3, 2026-Q2 x3
  for (let n = 1; n <= 140; n++) {
    const id = `D-${String(n).padStart(4, '0')}`
    const orphan = n % 23 === 0 && n / 23 <= 6
    const line = r.next() < 0.2 ? 'services' : 'platform'
    const day = orphan ? orphanDays[n / 23 - 1]! : r.int(0, span - 1)
    const first = { on: addDays(start, day), kind: r.next() < 0.125 ? 'winback' : 'new', amount: r.int(10, 120) * 50 }
    const events = [first]
    const expandAfter = r.int(30, 400)
    if (!orphan && r.next() < 0.4 && day + expandAfter < span) events.push({ on: addDays(start, day + expandAfter), kind: 'expansion', amount: r.int(2, 40) * 50 })
    await db.query(`INSERT INTO ${schema}.deals VALUES ($1, $2, $3)`, [id, orphan ? null : r.int(1, 90), line])
    for (const e of events) {
      await db.query(`INSERT INTO ${schema}.deal_events VALUES ($1, $2, $3, $4)`, [id, e.on, e.kind, e.amount])
      const category = line === 'services' ? 'expansion' : e.kind === 'winback' ? 'new' : e.kind
      await db.query(`INSERT INTO ${schema}.workbook VALUES ($1, $2, $3, $4)`, [id, e.on, category, e.amount])
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = connect()
  const c = await pool.connect()
  try {
    await seedDeals(c, 'ops_live')
    await seedDeals(c, 'ops_busy')
    await seedSupport(c)
    await seedApp(c)
    await seedRevenue(c)
    console.log('generated schemas ops_live, ops_busy, support, app_live, rev (anchor 2026-07-01)')
  } finally {
    c.release()
    await pool.end()
  }
}
