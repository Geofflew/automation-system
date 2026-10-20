import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'

export type ColumnGap = {
  table: string
  column: string
  problem: 'missing_column' | 'nullable' | 'no_default' | 'default_differs'
  want: { nullable: boolean; default: string | null; type: string }
  have?: { nullable: boolean; default: string | null }
  /** The live table has its own triggers, which a backfill UPDATE would fire. */
  triggers?: boolean
}

export const baselineFile = join(import.meta.dirname, '..', 'baseline', 'schema.sql')

type Col = { table: string; column: string; type: string; nullable: boolean; default: string | null }

async function columns(db: pg.ClientBase | pg.Pool, schema: string): Promise<Map<string, Col>> {
  const { rows } = await db.query<Col>(
    `SELECT table_name AS table, column_name AS column, data_type AS type,
            is_nullable = 'YES' AS nullable, column_default AS default
       FROM information_schema.columns WHERE table_schema = $1`,
    [schema],
  )
  // A default that names an object in its own schema (a sequence) prints with the schema; strip it
  // so the same default in two schemas compares equal.
  const strip = (d: string | null) => d?.replaceAll(`${schema}.`, '') ?? null
  return new Map(rows.map((r) => [`${r.table}.${r.column}`, { ...r, default: strip(r.default) }]))
}

/**
 * Builds the baseline into an empty scratch schema, where every CREATE TABLE runs in full and so
 * every NOT NULL and DEFAULT arrives, then compares column by column with live. Live is what the
 * copy tool made plus whatever the baseline's ADD COLUMN IF NOT EXISTS added; the scratch schema
 * is what the baseline means.
 */
export async function defaultsDiff(client: pg.ClientBase, live: string, baseline = baselineFile): Promise<ColumnGap[]> {
  const scratch = `${live}_baseline_scratch`
  await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE; CREATE SCHEMA ${scratch}`)
  await client.query(`SET search_path = ${scratch}`)
  try {
    await client.query(readFileSync(baseline, 'utf8'))
  } finally {
    await client.query('RESET search_path')
  }
  const [want, have] = [await columns(client, scratch), await columns(client, live)]
  await client.query(`DROP SCHEMA ${scratch} CASCADE`)
  const triggered = new Set(
    (
      await client.query<{ t: string }>(
        `SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
          WHERE c.relnamespace = $1::regnamespace AND NOT g.tgisinternal`,
        [live],
      )
    ).rows.map((r) => r.t),
  )
  const gaps: ColumnGap[] = []
  for (const [key, w] of [...want].sort(([a], [b]) => a.localeCompare(b))) {
    const h = have.get(key)
    const base = { table: w.table, column: w.column, want: { nullable: w.nullable, default: w.default, type: w.type }, triggers: triggered.has(w.table) }
    const haveOf = h && { nullable: h.nullable, default: h.default }
    if (!h) gaps.push({ ...base, problem: 'missing_column' })
    else if (w.default !== null && h.default === null) gaps.push({ ...base, problem: 'no_default', have: haveOf })
    else if (w.default !== h.default) gaps.push({ ...base, problem: 'default_differs', have: haveOf })
    else if (!w.nullable && h.nullable) gaps.push({ ...base, problem: 'nullable', have: haveOf })
  }
  return gaps
}

/**
 * The statements that close each gap, backfill first: SET NOT NULL fails on a NULL row, and the
 * rows that are NULL are the ones every compare-and-set has been missing. On a table with its
 * own triggers the backfill runs with them disabled: the trigger that bumps the revision on
 * every update would set NEW.revision to OLD.revision + 1, which is NULL, and undo the backfill
 * it is part of. A missing column is printed, not invented: its definition belongs to the
 * baseline, which was skipped for a reason someone should look at.
 */
export function fixStatements(live: string, gaps: ColumnGap[]): string[] {
  const out: string[] = []
  for (const g of gaps) {
    const t = `${live}.${g.table}`
    if (g.problem === 'missing_column') {
      out.push(`-- ${t}.${g.column} is missing: re-run its ADD COLUMN from the baseline`)
      continue
    }
    if (g.want.default !== null && g.have?.default !== g.want.default) {
      if (!g.want.nullable) {
        const backfill = `UPDATE ${t} SET ${g.column} = ${g.want.default} WHERE ${g.column} IS NULL;`
        out.push(g.triggers ? `ALTER TABLE ${t} DISABLE TRIGGER USER; ${backfill} ALTER TABLE ${t} ENABLE TRIGGER USER;` : backfill)
      }
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${g.column} SET DEFAULT ${g.want.default};`)
    }
    if (!g.want.nullable && g.have?.nullable) out.push(`ALTER TABLE ${t} ALTER COLUMN ${g.column} SET NOT NULL;`)
  }
  return out
}

/**
 * The write that the lost default breaks: read the row and its revision, then update only if
 * the revision is still the one read. With revision NULL, `revision = NULL` is never true, so
 * the update matches nothing and the caller sees a lost race on every attempt.
 */
export async function compareAndSet(db: pg.ClientBase | pg.Pool, live: string, id: number, phase: string): Promise<boolean> {
  const seen = await db.query<{ revision: number | null }>(`SELECT revision FROM ${live}.work_orders WHERE id = $1`, [id])
  const r = await db.query(`UPDATE ${live}.work_orders SET phase = $2 WHERE id = $1 AND revision = $3`, [id, phase, seen.rows[0]?.revision ?? null])
  return r.rowCount === 1
}
