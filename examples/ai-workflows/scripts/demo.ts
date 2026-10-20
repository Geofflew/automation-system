/**
 * pnpm demo: four agents, each BROKEN (limit in the prompt or absent) then GUARDED (limit in
 * code), then the shared ledger. Rebuilds the data before each run, so the output never changes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, resetLedger } from '../src/db.ts'
import { ScriptedModel } from '../src/model.ts'
import { DRAFT_PROMPT, MAX_POSTS_PER_RUN, runBroken, runGuarded } from '../src/questions.ts'
import { ask, askBroken, TOOL_BUDGET, type AskResult } from '../src/analyst.ts'
import { confirm, confirmBroken, propose, type Applied, type Change } from '../src/changes.ts'
import { BROKEN_PROMPT, fullClient, receive, work, workBroken } from '../src/triage.ts'
import { load, REPO_ROOT } from './generate.ts'

const db = connect()
const say = (s = '') => console.log(s)
const head = (s: string) => say(`\n${'='.repeat(100)}\n${s}\n${'='.repeat(100)}`)
const cut = (s: string, n = 92) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

say('agents-that-know-their-limits. The model is scripted (src/model.ts): no API key, same output every run.')
await load(db)
await resetLedger(db)

// ---- 1 ---------------------------------------------------------------------------------------
head('1. Product-questions bot: a refusal gate and a post cap')
const broken1 = await runBroken(db, new ScriptedModel(), 'run-1')
say(`BROKEN   the drafter's prompt: "${DRAFT_PROMPT}"`)
say(`         no gate, no cap. ${broken1.posted.length} of ${broken1.posted.length} open questions answered in the channel:`)
for (const p of broken1.posted) say(`         #${String(p.id).padEnd(3)}${cut(p.answer, 70)}${p.source ? '' : '   <- no source'}`)

await load(db)
const model1 = new ScriptedModel()
const g1 = await runGuarded(db, model1, 'run-1', REPO_ROOT)
say(`\nGUARDED  gate + cap of ${MAX_POSTS_PER_RUN} posts per run:`)
for (const p of g1.posted) say(`  posted   #${String(p.id).padEnd(3)}${cut(p.answer, 64)} [${p.source}]`)
for (const d of g1.deferred) say(`  deferred #${String(d.id).padEnd(3)}${cut(d.question, 64)} (over the cap; released for the next run)`)
for (const r of g1.refused) say(`  refused  #${String(r.id).padEnd(3)}${cut(r.question, 64).padEnd(66)}${r.reason}`)
const run1Calls = model1.calls
const g1b = await runGuarded(db, model1, 'run-2', REPO_ROOT)
say(`  next run: posted ${g1b.posted.map((p) => `#${p.id}`).join(', ')}; claimed ${g1b.posted.length + g1b.refused.length + g1b.deferred.length} question(s) (refusals stay refused)`)
const judged = g1.posted.length + g1.deferred.length + g1.refused.filter((r) => r.reason === 'off_question').length
say(`  model calls in run 1: ${run1Calls} (${g1.posted.length + g1.deferred.length + g1.refused.length} drafts + ${judged} judge calls, only for drafts that passed the free checks)`)
const limits = readFileSync(join(REPO_ROOT, 'docs/api-limits.md'), 'utf8').split('\n')[2]
const wrong = g1.posted.find((p) => p.source === 'docs/api-limits.md')!
say(`\nLIMIT    #${wrong.id} posted "${cut(wrong.answer, 50)}"; its source says "${cut(limits!, 46)}"`)
say('         The gate checks that a source exists, not that it says what the answer says.')
say(`\nDIFF     ${broken1.posted.length} posts -> ${g1.posted.length} (+${g1b.posted.length} next run). The SOC 2 / 99.99% over-claim: posted -> refused no_source.`)

// ---- 2 ---------------------------------------------------------------------------------------
head(`2. Read-only analyst: a tool budget of ${TOOL_BUDGET}, a forced conclusion, a reply protocol`)
await load(db)
const name = async (id: number) => (await db.query('SELECT name FROM accounts WHERE id = $1', [id])).rows[0].name as string
const calls = (r: AskResult) => r.transcript.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' ? [b.name] : [])))
const a = await name(12)
const runaway = `Has "${a}"'s support load gone up?`
const rb = await askBroken(db, new ScriptedModel(), runaway)
say(`Q: ${runaway}`)
say(`BROKEN   budget in the prompt only: ${rb.outcome}, ${rb.toolCalls} tool calls, no answer (demo safety stop at 20)`)
say(`         calls: ${calls(rb).slice(0, 5).join(', ')}, ... the same pair every turn`)
const rg = await ask(db, new ScriptedModel(), runaway)
const over = rg.transcript.flatMap((m) => m.content.filter((b) => b.type === 'tool_result' && b.is_error))
say(`GUARDED  ${rg.outcome} after ${rg.toolCalls} tool calls. The 7th call in the last turn got a tool_result too: ${over.length} error result`)
say(`         ("${over[0]?.type === 'tool_result' ? over[0].content : ''}") in the same message as the other results and the conclude prompt.`)
say(`         answer: ${rg.outcome === 'forced' ? rg.text : ''}`)

// The first account with an open deal and an open ticket, so the normal question has something to find.
const b = (await db.query(`SELECT name FROM accounts a WHERE EXISTS (SELECT 1 FROM deals WHERE account_id = a.id AND stage = 'open')
  AND EXISTS (SELECT 1 FROM tickets WHERE account_id = a.id AND status = 'open') ORDER BY id LIMIT 1`)).rows[0].name as string
const deals = `What open deals does "${b}" have, and how many open tickets?`
const dg = await ask(db, new ScriptedModel(), deals)
say(`\nQ: ${deals}`)
say(`GUARDED  ${dg.outcome} after ${dg.toolCalls} tool calls (${calls(dg).join(', ')}): ${dg.outcome === 'answer' ? dg.text : ''}`)

const c = await name(3)
const health = `What is the health score for "${c}"?`
const hb = await askBroken(db, new ScriptedModel(), health)
const hg = await ask(db, new ScriptedModel(), health)
say(`\nQ: ${health}   (no tool defines a health score)`)
say(`BROKEN   prompt says "never both". The person sees the guess and the question:`)
for (const l of hb.outcome === 'answer' ? hb.text.split('\n') : []) say(`           | ${l}`)
say(`GUARDED  parser: ${hg.outcome}. Shown: "CLARIFY: ${hg.outcome === 'clarify' ? hg.question : ''}"`)
say(`         dropped, never shown: "${hg.outcome === 'clarify' ? hg.dropped : ''}"`)

// ---- 3 ---------------------------------------------------------------------------------------
head('3. Confirm-before-change: the server applies the stored list, never the list in the message')
const owned = async (owner: string) => Number((await db.query('SELECT count(*) FROM accounts WHERE owner = $1', [owner])).rows[0].count)
const all = async (from: string, to: string): Promise<Change[]> =>
  (await db.query(`SELECT id AS account_id, name, owner AS "from", $2::text AS "to" FROM accounts WHERE owner = $1 ORDER BY id`, [from, to])).rows
const request = "Move Lee Marsh's EMEA accounts to Priya Raman."
const show = (r: Applied) => (r.ok ? `applied ${r.applied.length}${r.refused.length ? `, refused ${r.refused.map((x) => `${x.change.name}: ${x.reason}`).join('; ')}` : ''}` : `refused: ${r.reason}`)

await load(db)
const m3 = new ScriptedModel()
const p1 = await propose(db, m3, 's-1', request, true)
say(`Person: "${request}"`)
say(`Agent proposes ${p1.changes.length} changes, turn ${p1.turn_id}: ${p1.changes.map((x) => x.name).join(', ')}. Person: "yes".`)
const relayed = m3.relay(p1.changes, await all('Lee Marsh', 'Priya Raman'))
say(`The model relays the yes with ${relayed.length} changes: every account Lee Marsh has.`)
const before = await owned('Priya Raman')
const r0 = await confirmBroken(db, { session_id: 's-1', turn_id: p1.turn_id, confirmed: true, changes: relayed })
say(`BROKEN   ${show(r0)}. Priya Raman owned ${before}, now ${await owned('Priya Raman')}: ${relayed.length - p1.changes.length} rows nobody was shown.`)

await load(db)
const m3g = new ScriptedModel()
const q1 = await propose(db, m3g, 's-1', request, true)
const relayed2 = m3g.relay(q1.changes, await all('Lee Marsh', 'Priya Raman'))
say(`GUARDED  edited list:          ${show(await confirm(db, { session_id: 's-1', turn_id: q1.turn_id, confirmed: true, changes: relayed2 }))}`)
say(`         turn id + yes:        ${show(await confirm(db, { session_id: 's-1', turn_id: q1.turn_id, confirmed: true }))}. Priya Raman owns ${await owned('Priya Raman')}.`)
say(`         same yes again:       ${show(await confirm(db, { session_id: 's-1', turn_id: q1.turn_id, confirmed: true }))}`)
const t1 = await propose(db, m3g, 's-2', "Move Dana Okafor's APAC accounts to Sam Whitlock.", true)
const t2 = await propose(db, m3g, 's-2', "Move Dana Okafor's NA accounts to Sam Whitlock.", true)
say(`         superseded turn:      ${show(await confirm(db, { session_id: 's-2', turn_id: t1.turn_id, confirmed: true }))} (the person changed the request)`)
await db.query("UPDATE accounts SET owner = 'Ines Kowal' WHERE id = $1", [t2.changes[0]!.account_id])
say(`         row moved meanwhile:  ${show(await confirm(db, { session_id: 's-2', turn_id: t2.turn_id, confirmed: true }))}`)
const sched = await propose(db, m3g, 's-3', "Move Tomas Vidal's EMEA accounts to Lee Marsh.", false)
say(`         scheduled run:        ${show(await confirm(db, { session_id: 's-3', turn_id: sched.turn_id, confirmed: true, interactive: false }))} (proposal of ${sched.changes.length} recorded, never applicable)`)

// ---- 4 ---------------------------------------------------------------------------------------
head('4. Support triage: internal notes only, cause as a check, one note per event')
const evA = JSON.stringify({ event_id: 'evt_001', ticket_id: 501, subject: 'Our sync stopped updating on Tuesday', body: 'The dashboard still shows Monday figures.' })
const evB = JSON.stringify({ event_id: 'evt_002', ticket_id: 502, subject: 'Need a copy of the last quarter invoice', body: 'Finance asked for a PDF copy.' })
const visible = async () => (await db.query("SELECT ticket_id, body FROM ticket_messages WHERE visibility = 'customer' ORDER BY id")).rows

await load(db)
for (const ev of [evA, evB]) await receive(db, ev)
await workBroken(db, new ScriptedModel(), fullClient(db))
say(`BROKEN   client has reply(); prompt: "${BROKEN_PROMPT}"`)
for (const v of await visible()) say(`         sent to customer on #${v.ticket_id}: "${cut(v.body, 74)}"`)

await load(db)
const codes = [await receive(db, evA), await receive(db, evB), await receive(db, evA)]
await work(db, new ScriptedModel())
await receive(db, evA)
await work(db, new ScriptedModel())
const notes = (await db.query("SELECT ticket_id, body FROM ticket_messages WHERE visibility = 'internal' ORDER BY id")).rows
say(`GUARDED  deliveries A, B, A -> ${codes.join(', ')}; A again after the worker ran -> 200. Events stored: ` +
  `${(await db.query('SELECT count(*) FROM webhook_events')).rows[0].count}, notes written: ${notes.length}, sent to customer: ${(await visible()).length}`)
for (const n of notes) {
  say(`  note on #${n.ticket_id}:`)
  for (const l of (n.body as string).split('\n')) say(`    ${l}`)
}
const tried = (await db.query("SELECT count(*) FROM ledger WHERE agent = 'triage' AND action = 'reply' AND outcome LIKE 'not sent%'")).rows[0].count
say(`         the model wrote a reply both times; ${tried} ledger rows say "not sent: client has no reply method".`)

// ---- ledger ----------------------------------------------------------------------------------
head('Ledger: every action any agent took, broken runs included')
const { rows } = await db.query(`SELECT agent, action, regexp_replace(outcome, '[0-9]+', 'N', 'g') AS outcome, count(*) AS n, min(at) AS first
  FROM ledger GROUP BY 1, 2, 3 ORDER BY min(id)`)
say(`${'agent'.padEnd(10)}${'action'.padEnd(9)}${'n'.padStart(3)}  ${'first at'.padEnd(17)}  outcome`)
for (const r of rows) say(`${r.agent.padEnd(10)}${r.action.padEnd(9)}${String(r.n).padStart(3)}  ${r.first}  ${r.outcome}`)
const sample = (await db.query("SELECT * FROM ledger WHERE agent = 'changes' ORDER BY id DESC LIMIT 3")).rows.reverse()
say(`\nlast 3 rows for agent changes (id, at, actor, action, inputs_hash, outcome):`)
for (const r of sample) say(`  ${r.id}  ${r.at}  ${r.actor}  ${r.action.padEnd(8)} ${r.inputs_hash}  ${r.outcome}`)
say(`total rows: ${(await db.query('SELECT count(*) FROM ledger')).rows[0].count}`)
await db.end()
