/**
 * The synthetic dataset for Acme Analytics: 60 accounts with owners, deals, 40 resolved support
 * tickets (the triage corpus) plus 30 open ones, a chat channel transcript, and a fake product repo
 * of markdown files that answers must cite. Seeded and anchored, so every run is identical.
 *
 * The traps, by row:
 * - messages: the over-claim question (SOC 2 and uptime), the BigQuery question whose draft cites a
 *   file that does not exist, and the rate-limit question whose draft cites a real file and states
 *   the wrong number (docs/api-limits.md says 300).
 * - accounts: owner "Lee Marsh" has 10 accounts, 3 of them in EMEA; the confirm demo proposes the 3.
 * - tickets: five resolved tickets per problem, so an incoming ticket about a stalled sync has
 *   past tickets with its cause.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, setup, type Db } from '../src/db.ts'

export const SEED = 20260302
export const REPO_ROOT = new URL('../out/product-repo', import.meta.url).pathname

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ADJ = ['Brisk', 'Cobalt', 'Quiet', 'Amber', 'Northern', 'Lucid', 'Granite', 'Hollow', 'Copper', 'Tidal', 'Velvet', 'Ember']
const NOUN = ['Harbor', 'Ledger', 'Pine', 'Signal', 'Forge', 'Meadow', 'Orbit', 'Willow', 'Canyon', 'Lantern']
const SUFFIX = ['Labs', 'Works', 'Group', 'Co', 'Partners']
export const OWNERS = ['Dana Okafor', 'Lee Marsh', 'Priya Raman', 'Tomas Vidal', 'Ines Kowal', 'Sam Whitlock']
const REGIONS = ['NA', 'EMEA', 'APAC']
const day = (offset: number) => new Date(Date.parse('2026-03-02') + offset * 86_400_000).toISOString().slice(0, 10)

/** Eight problems the support team has seen many times. Each has a cause a customer can check. */
const PROBLEMS = [
  {
    cause: 'an expired connection token on the customer side',
    check: 'whether Settings, Connections shows the source connection as expired',
    staffFix: 'rotate the service credential and replay the sync queue',
    subjects: ['Nightly sync stopped updating', 'Sync has not run since Monday', 'Dashboard numbers stuck, sync not updating',
      'Data sync stalled overnight', 'Sync stopped and figures are old'],
  },
  {
    cause: 'a saved view that hides those columns',
    check: 'whether the export was run from a saved view with hidden columns',
    staffFix: 'patch the export template in the admin tool',
    subjects: ['CSV export is missing columns', 'Export dropped two columns', 'Columns missing from the export file',
      'Exported report has fewer columns than the screen', 'Export leaves out the owner column'],
  },
  {
    cause: 'an identity provider callback address that still points at the old workspace address',
    check: 'the callback address in the identity provider app settings',
    staffFix: 'reissue the SAML metadata from the internal console',
    subjects: ['SSO login loops back to the sign-in page', 'Single sign-on redirects forever', 'Users stuck in a login loop after SSO change',
      'SSO sign-in keeps redirecting', 'Login loop since we moved identity provider'],
  },
  {
    cause: 'a company mail filter quarantining notification mail',
    check: 'the mail quarantine for messages from the notifications sender',
    staffFix: 'whitelist the tenant on the mail relay',
    subjects: ['Not receiving notification emails', 'Approval emails never arrive', 'Reminder emails stopped arriving',
      'Team gets no email notifications', 'Notification mail missing for all users'],
  },
  {
    cause: 'a report filtered to a different period than the dashboard',
    check: 'the period filter on both the report and the dashboard',
    staffFix: 'rebuild the reporting cache for the workspace',
    subjects: ['Report total does not match the dashboard', 'Numbers differ between report and dashboard', 'Dashboard and report disagree on revenue',
      'Report shows a different total', 'Mismatch between report and dashboard figures'],
  },
  {
    cause: 'an invitation sent to a different workspace',
    check: 'which workspace the invitation email names',
    staffFix: 'move the user record between workspaces in the database',
    subjects: ['New user cannot see our workspace', 'Invited colleague sees an empty workspace', 'User added but workspace not visible',
      'Teammate cannot find our workspace after invite', 'Invite accepted, workspace missing'],
  },
  {
    cause: 'a file over the 50 MB upload limit',
    check: 'the file size, and split the file if it is over 50 MB',
    staffFix: 'raise the upload limit for the tenant',
    subjects: ['Upload fails with no error', 'Cannot upload the trial balance file', 'File upload spins and fails',
      'Large upload keeps failing', 'Upload of the ledger file times out'],
  },
  {
    cause: 'a script that retries without backoff and hits the rate limit',
    check: 'whether the script retries immediately after a 429 response',
    staffFix: 'raise the API quota for the workspace',
    subjects: ['API returns 429 errors', 'Getting rate limited on the API', 'API calls rejected with too many requests',
      'Integration script hits 429', 'API throttling our nightly job'],
  },
]

/** The channel transcript. Twelve lines end in a question mark; one of them a person already answered. */
export const TRANSCRIPT: { author: string; text: string; reply?: number }[] = [
  { author: 'Rae Lindqvist', text: 'Morning all. Pipeline review moved to 3pm.' },
  { author: 'Omar Feld', text: 'Can a customer export the audit log to CSV? Their controller asked on the call.' },
  { author: 'Bea Tanaka', text: 'Thanks Rae.' },
  { author: 'Cole Brandt', text: 'Does SSO include SCIM provisioning, or is that separate?' },
  { author: 'Rae Lindqvist', text: "Who has the slides from Tuesday's demo?" },
  { author: 'Omar Feld', text: "What's the API rate limit per workspace? The prospect plans a nightly pull." },
  { author: 'Bea Tanaka', text: 'Are we SOC 2 Type II certified, and do we guarantee 99.99% uptime?' },
  { author: 'Cole Brandt', text: 'Heads up, the trial workspace for the logistics prospect expires Friday.' },
  { author: 'Rae Lindqvist', text: 'Does the warehouse connector support BigQuery?' },
  { author: 'Omar Feld', text: 'Can approvals require two reviewers before a period is locked?' },
  { author: 'Bea Tanaka', text: 'Is data retention configurable per customer?' },
  { author: 'Cole Brandt', text: 'Do we have a way to restrict exports by role?' },
  { author: 'Rae Lindqvist', text: 'Shared the security questionnaire in the deal folder.' },
  { author: 'Rae Lindqvist', text: 'Is the mobile app read-only?' },
  { author: 'Tomas Vidal', text: 'Yes, read-only for now. Approvals on mobile are planned, no date yet.', reply: 14 },
  { author: 'Omar Feld', text: 'Can someone confirm the export size limit?' },
  { author: 'Bea Tanaka', text: "Does the retention policy apply to deleted users' data?" },
  { author: 'Cole Brandt', text: 'Closed the renewal with the logistics customer, two years.' },
  { author: 'Omar Feld', text: 'Reminder: update next steps in the CRM before Thursday.' },
  { author: 'Bea Tanaka', text: 'Demo environment is slow this morning, product knows.' },
  { author: 'Rae Lindqvist', text: 'Great call with the finance team at the retail prospect.' },
  { author: 'Cole Brandt', text: 'Out tomorrow afternoon, Omar is covering my calls.' },
  { author: 'Omar Feld', text: 'Thanks for the help on the pricing thread earlier.' },
  { author: 'Bea Tanaka', text: 'Lunch is in the kitchen.' },
  { author: 'Rae Lindqvist', text: 'Coffee machine on three is fixed.' },
  { author: 'Cole Brandt', text: 'Added the call notes to the deal.' },
]

/** The fake product repo. The gate checks that an answer's source is one of these paths. */
export const PRODUCT_DOCS: Record<string, string> = {
  'docs/audit-log.md': '# Audit log\n\nAdmins can export the audit log as CSV from Settings, Audit log. Exports cover the last 365 days.\n',
  'docs/sso.md': '# SSO\n\nSAML single sign-on is on the Enterprise plan. SCIM 2.0 provisioning comes with it: create, update, deactivate.\n',
  'docs/api-limits.md': '# API limits\n\nEach workspace may make 300 requests per minute. Over the limit the API returns 429 with Retry-After.\n',
  'docs/approvals.md': '# Approvals\n\nAn approval rule may require one or two reviewers. A period cannot lock until every required reviewer approves.\n',
  'docs/exports.md': '# Exports\n\nAn export file holds at most 1,000,000 rows. Larger exports are split into several files.\n',
  'docs/permissions.md': '# Permissions\n\nRoles are Admin, Editor and Viewer. Admins choose which roles may export.\n',
  'docs/data-retention.md': '# Data retention\n\nRetention is set per workspace, from 1 to 7 years. Deleted users are anonymised after 30 days.\n',
  'docs/integrations/postgres.md': '# Postgres connector\n\nThe Postgres connector syncs every hour over a read-only role.\n',
}

export async function load(db: Db): Promise<void> {
  await setup(db)
  const r = rng(SEED)
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!

  // Names: shuffle every combination, take the first 60.
  const combos = ADJ.flatMap((a) => NOUN.flatMap((n) => SUFFIX.map((s) => `${a} ${n} ${s}`)))
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[combos[i], combos[j]] = [combos[j]!, combos[i]!]
  }
  const accounts = combos.slice(0, 60).map((name, i) => ({
    id: i + 1, name, owner: OWNERS[i % 6]!, region: REGIONS[Math.floor(i / 6) % 3]!,
  }))
  await db.query(
    `INSERT INTO accounts SELECT * FROM jsonb_to_recordset($1) AS x(id int, name text, owner text, region text)`,
    [JSON.stringify(accounts)],
  )

  const deals = accounts.flatMap((a) =>
    Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({
      account_id: a.id, stage: pick(['open', 'open', 'won', 'lost']), amount: (12 + Math.floor(r() * 85)) * 1000,
      closes_on: day(Math.floor(r() * 180) - 90),
    })),
  ).map((d, i) => ({ id: i + 1, ...d }))
  await db.query(
    `INSERT INTO deals SELECT * FROM jsonb_to_recordset($1) AS x(id int, account_id int, stage text, amount int, closes_on date)`,
    [JSON.stringify(deals)],
  )

  const resolved = PROBLEMS.flatMap((p) => p.subjects.map((subject) => ({
    account_id: 1 + Math.floor(r() * 60), subject, status: 'resolved', priority: pick(['low', 'normal', 'urgent']),
    body: `${subject}. ${pick(['Started this week.', 'Several users affected.', 'Blocking our close.', 'Seen since the last release.'])}`,
    opened_on: day(-30 - Math.floor(r() * 300)), cause: p.cause, customer_check: p.check, staff_fix: p.staffFix,
  })))
  const open = Array.from({ length: 30 }, () => {
    const subject = pick(['Question about a report filter', 'Request to add a user', 'Slow dashboard load', 'Field missing on import', 'Billing contact change'])
    return { account_id: 1 + Math.floor(r() * 60), subject, body: `${subject}.`, status: 'open', priority: pick(['low', 'normal', 'normal', 'urgent']),
      opened_on: day(-Math.floor(r() * 30)), cause: null, customer_check: null, staff_fix: null }
  })
  const tickets = [...resolved, ...open].map((t, i) => ({ id: i + 1, ...t }))
  await db.query(
    `INSERT INTO tickets SELECT * FROM jsonb_to_recordset($1) AS x(id int, account_id int, subject text, body text, status text,
       priority text, opened_on date, cause text, customer_check text, staff_fix text)`,
    [JSON.stringify(tickets)],
  )

  for (const [i, m] of TRANSCRIPT.entries()) {
    const ts = `09:${String(2 + i * 2).padStart(2, '0')}`
    await db.query('INSERT INTO messages (ts, author, text, reply_to) VALUES ($1, $2, $3, $4)', [ts, m.author, m.text, m.reply ?? null])
  }

  rmSync(REPO_ROOT, { recursive: true, force: true })
  for (const [path, body] of Object.entries(PRODUCT_DOCS)) {
    mkdirSync(dirname(join(REPO_ROOT, path)), { recursive: true })
    writeFileSync(join(REPO_ROOT, path), body)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const db = connect()
  await load(db)
  const { rows } = await db.query(`SELECT (SELECT count(*) FROM accounts) a, (SELECT count(*) FROM deals) d,
    (SELECT count(*) FROM tickets WHERE status = 'resolved') c, (SELECT count(*) FROM messages) m`)
  console.log(`generated: ${rows[0].a} accounts, ${rows[0].d} deals, ${rows[0].c} resolved tickets, ${rows[0].m} messages, ` +
    `${Object.keys(PRODUCT_DOCS).length} product docs (seed ${SEED})`)
  await db.end()
}
