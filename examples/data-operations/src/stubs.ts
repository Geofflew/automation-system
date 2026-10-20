import type pg from 'pg'

export type Stub = { view: string; column: string; type: string; source: string; filled: number; rows: number }

// pg_get_viewdef prints a stub as `NULL::text AS product_type`, with a multi-word type
// (`NULL::timestamp with time zone AS closed_at`), or with a modifier (`NULL::character
// varying(40)`, `NULL::numeric(12,2)`), and quotes the alias only when it must. The type is
// matched lazily up to the first " AS ", which no type name contains.
const STUB = /NULL::([a-z][a-z0-9_ (),]*?(?:\[\])?) AS "?([a-z_][a-z0-9_]*)"?/gi

/**
 * Views in `schema` that select `NULL::<type> AS <col>` while a table the view reads has a column
 * named `<col>`. A stub with no such column anywhere is left alone: it may be deliberate. Each
 * finding says how many of the source's rows now have a value, which is what the screen is hiding.
 */
export async function findStubs(db: pg.ClientBase | pg.Pool, schema: string): Promise<Stub[]> {
  const views = await db.query<{ view: string; def: string }>(
    `SELECT c.relname AS view, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY 1`,
    [schema],
  )
  const out: Stub[] = []
  for (const v of views.rows) {
    for (const [, type, column] of v.def.matchAll(STUB)) {
      // The tables this view reads directly, from the dependency catalog rather than by parsing SQL.
      // regclass prints the name schema-qualified and quoted as needed, so the count below finds a
      // source in another schema (a semantic view over a raw table) without re-qualifying it.
      const sources = await db.query<{ source: string }>(
        `SELECT DISTINCT t.oid::regclass::text AS source
           FROM pg_rewrite r
           JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
           JOIN pg_class t ON t.oid = d.refobjid AND t.oid <> r.ev_class AND t.relkind IN ('r', 'p', 'v', 'm', 'f')
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = $3 AND NOT a.attisdropped
          WHERE r.ev_class = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = $2::regnamespace)
          ORDER BY 1`,
        [v.view, schema, column],
      )
      for (const { source } of sources.rows) {
        const n = await db.query<{ filled: number; rows: number }>(
          `SELECT count(${quote(column!)})::int AS filled, count(*)::int AS rows FROM ${source}`,
        )
        out.push({ view: v.view, column: column!, type: type!, source, ...n.rows[0]! })
      }
    }
  }
  return out
}

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`

/** The screen's rule, as most screens have it: a filter with no values is not shown. */
export function visibleFilters(rows: Record<string, unknown>[], columns: string[]): string[] {
  return columns.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined))
}
