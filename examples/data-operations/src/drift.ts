import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { migrate } from './migrate.ts'

export type Definition = { name: string; kind: 'view' | 'function'; body: string }
export type Drift = { name: string; kind: string; status: 'differs' | 'missing_live' | 'extra_live'; live?: string; repo?: string }

// Both sides come from Postgres's own printer, so they agree byte for byte when the objects agree.
// Only the ends are trimmed: rewriting whitespace inside the body would also rewrite string
// literals, and `'a b'` against `'a  b'` is a real change.
const normalise = (s: string) => s.trim()

/**
 * Every view and function body in one schema, as Postgres itself prints them. The search_path is
 * set to that schema alone while printing, so pg_get_viewdef leaves names in it unqualified and
 * the live schema and the scratch schema print identically when they agree.
 */
export async function definitions(client: pg.ClientBase, schema: string): Promise<Map<string, Definition>> {
  await client.query(`SET search_path = ${schema}`)
  try {
    const { rows } = await client.query<Definition>(
      `SELECT c.relname AS name, 'view' AS kind, pg_get_viewdef(c.oid, true) AS body
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
       UNION ALL
       SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', 'function',
              pg_get_function_result(p.oid) || ' ' || p.prosrc
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1`,
      [schema],
    )
    return new Map(rows.map((r) => [r.name, { ...r, body: normalise(r.body) }]))
  } finally {
    await client.query('RESET search_path')
  }
}

/**
 * What the live schema runs against what the repo's migrations produce. The migrations table on
 * live says which files ran, not what they said when they ran, so the only evidence of an edit
 * after apply is the object itself: build the repo into an empty scratch schema and diff.
 */
export async function drift(client: pg.ClientBase, dir: string, live: string, scratch = `${live}_drift_scratch`): Promise<Drift[]> {
  await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`)
  await migrate(client, dir, scratch)
  const [have, want] = [await definitions(client, live), await definitions(client, scratch)]
  await client.query(`DROP SCHEMA ${scratch} CASCADE`)
  const out: Drift[] = []
  for (const [name, w] of want) {
    const h = have.get(name)
    if (!h) out.push({ name, kind: w.kind, status: 'missing_live', repo: w.body })
    else if (h.body !== w.body) out.push({ name, kind: w.kind, status: 'differs', live: h.body, repo: w.body })
  }
  for (const [name, h] of have) if (!want.has(name)) out.push({ name, kind: h.kind, status: 'extra_live', live: h.body })
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The cheap pre-check: a migration file with more than one commit was changed after it was first
 * written, which is the shape of an edit after apply. It cannot tell an edited comment from an
 * edited view body, so it names suspects; `drift` decides.
 */
export function suspects(dir: string): { file: string; commits: number }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const log = execFileSync('git', ['log', '--oneline', '--', file], { cwd: dir, encoding: 'utf8' })
      return { file, commits: log.split('\n').filter(Boolean).length }
    })
    .filter((s) => s.commits > 1)
}

/** A two-line view of where two bodies first part, for printing. */
export function firstDifference(a: string, b: string, width = 46): [string, string] {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 12)
  return [a.slice(from, from + width), b.slice(from, from + width)]
}

export const migrationsDir = join(import.meta.dirname, '..', 'migrations')
