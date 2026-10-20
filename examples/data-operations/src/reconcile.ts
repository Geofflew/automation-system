import type pg from 'pg'

/**
 * The finance workbook's rules, as mappings from the ledger's category to the workbook's. The
 * ledger keeps the distinctions (a win-back is not a new logo; the services line is not product
 * expansion); the workbook does not. Each rule is a decision someone made, so each is named and
 * applied on purpose, never folded into the ledger itself.
 */
export const RULES = {
  services_in_expansion: { from: 'services', to: 'expansion', says: 'the services line folded into expansion' },
  winback_as_new: { from: 'winback', to: 'new', says: 'win-backs counted as new' },
} as const
export type Rule = keyof typeof RULES

const category = (rules: Rule[]) =>
  rules.length ? `CASE ${rules.map((r) => `WHEN l.category = '${RULES[r].from}' THEN '${RULES[r].to}'`).join(' ')} ELSE l.category END` : 'l.category'

/** The ledger as the workbook would label it, one row per deal per day per category. */
const ledgerAs = (schema: string, rules: Rule[]) =>
  `SELECT l.deal_id, l.booked_on, ${category(rules)} AS category, sum(l.amount) AS amount
     FROM ${schema}.ledger l GROUP BY 1, 2, 3`

export type QuarterRow = { quarter: string; ledger_new: number; book_new: number; ledger_expansion: number; book_expansion: number; match: boolean }

/** New and expansion per quarter on both sides; a quarter matches when both are equal to the cent. */
export async function quarters(db: pg.ClientBase | pg.Pool, schema: string, rules: Rule[]): Promise<QuarterRow[]> {
  const { rows } = await db.query<QuarterRow>(
    `WITH l AS (${ledgerAs(schema, rules)}),
          q AS (
            SELECT to_char(booked_on, 'YYYY-"Q"Q') AS quarter, 'ledger' AS side, category, amount FROM l
            UNION ALL
            SELECT to_char(booked_on, 'YYYY-"Q"Q'), 'book', category, amount FROM ${schema}.workbook)
     SELECT quarter,
            coalesce(sum(amount) FILTER (WHERE side = 'ledger' AND category = 'new'), 0) AS ledger_new,
            coalesce(sum(amount) FILTER (WHERE side = 'book' AND category = 'new'), 0) AS book_new,
            coalesce(sum(amount) FILTER (WHERE side = 'ledger' AND category = 'expansion'), 0) AS ledger_expansion,
            coalesce(sum(amount) FILTER (WHERE side = 'book' AND category = 'expansion'), 0) AS book_expansion
       FROM q GROUP BY quarter ORDER BY quarter`,
  )
  return rows.map((r) => ({ ...r, match: r.ledger_new === r.book_new && r.ledger_expansion === r.book_expansion }))
}

export type Residual = { deal_id: string; booked_on: string; category: string; ledger: number | null; book: number | null; cause: string }

/**
 * Every deal-day-category where the two sides differ, each traced to a cause from the source
 * rows rather than left as a number. A total that matches can hide two errors that cancel;
 * a deal-by-deal match cannot.
 */
export async function residual(db: pg.ClientBase | pg.Pool, schema: string, rules: Rule[]): Promise<Residual[]> {
  const { rows } = await db.query<Residual>(
    `WITH l AS (${ledgerAs(schema, rules)})
     SELECT coalesce(l.deal_id, b.deal_id) AS deal_id, coalesce(l.booked_on, b.booked_on) AS booked_on,
            coalesce(l.category, b.category) AS category, l.amount AS ledger, b.amount AS book,
            CASE
              WHEN l.deal_id IS NULL AND d.id IS NULL THEN 'deal not in the event stream'
              WHEN l.deal_id IS NULL AND d.company_id IS NULL THEN 'deal has no company link; the ledger reads deals through companies'
              WHEN l.deal_id IS NULL AND c.id IS NULL THEN 'deal links to a company that does not exist'
              WHEN l.deal_id IS NULL THEN 'in the workbook only'
              WHEN b.deal_id IS NULL THEN 'in the ledger only'
              ELSE 'amounts differ'
            END AS cause
       FROM l
       FULL JOIN ${schema}.workbook b ON b.deal_id = l.deal_id AND b.booked_on = l.booked_on AND b.category = l.category
       LEFT JOIN ${schema}.deals d ON d.id = coalesce(l.deal_id, b.deal_id)
       LEFT JOIN ${schema}.companies c ON c.id = d.company_id
      WHERE l.amount IS DISTINCT FROM b.amount
      ORDER BY 2, 1, 3`,
  )
  return rows
}

export type Report = { steps: { rules: Rule[]; matched: number; quarters: number }[]; quarters: QuarterRow[]; residual: Residual[]; residualTotal: number; dealDays: { matched: number; total: number } }

/** Rules applied one at a time, so the printout says which rule closed which gap. */
export async function reconcile(db: pg.ClientBase | pg.Pool, schema: string): Promise<Report> {
  const all = Object.keys(RULES) as Rule[]
  const steps: Report['steps'] = []
  for (let i = 0; i <= all.length; i++) {
    const q = await quarters(db, schema, all.slice(0, i))
    steps.push({ rules: all.slice(0, i), matched: q.filter((r) => r.match).length, quarters: q.length })
  }
  const res = await residual(db, schema, all)
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.workbook`)).rows[0]!.n
  return {
    steps,
    quarters: await quarters(db, schema, all),
    residual: res,
    residualTotal: res.reduce((s, r) => s + (r.book ?? 0) - (r.ledger ?? 0), 0),
    dealDays: { matched: total - res.filter((r) => r.book !== null).length, total },
  }
}
