import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { connect, resetLedger, setup } from '../src/db.ts'
import { checkTranscript, ScriptedModel, type Message } from '../src/model.ts'
import { cheapChecks, gate, normalise, runBroken, runGuarded, sourceExists } from '../src/questions.ts'
import { ask, askBroken, FORCED_PREFIX, parseReply, TOOL_BUDGET } from '../src/analyst.ts'
import { confirm, confirmBroken, mismatch, propose } from '../src/changes.ts'
import { composeNote, notesClient, oneQuestion, receive, similar, work, workBroken, fullClient } from '../src/triage.ts'
import { load, REPO_ROOT } from '../scripts/generate.ts'

const db = connect()
beforeAll(async () => {
  // CI starts with an empty database; create the ledger before resetting it.
  await setup(db)
  await resetLedger(db)
})
beforeEach(() => load(db))
afterAll(() => db.end())

const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].count)

describe('1. product-questions gate', () => {
  it('refuses each untrustworthy draft for its own reason', async () => {
    const r = await runGuarded(db, new ScriptedModel(), 'r1', REPO_ROOT)
    expect(Object.fromEntries(r.refused.map((x) => [x.id, x.reason]))).toEqual({
      5: 'no_confidence', 7: 'no_source', 9: 'source_not_found', 11: 'low_confidence', 12: 'hedged', 16: 'announces', 17: 'off_question',
    })
  })

  it('catches a hedge written with a typographic apostrophe', () => {
    const d = { answer: 'I’m not certain it does.', confidence: 0.9, source: 'docs/sso.md' }
    expect(cheapChecks(d, REPO_ROOT)).toBe('hedged')
    expect(normalise('I’m')).toBe("i'm")
  })

  it('refuses a source outside the product repo even though the file exists', () => {
    expect(sourceExists(REPO_ROOT, '../../package.json')).toBe(false)
    expect(sourceExists(REPO_ROOT, 'docs/sso.md')).toBe(true)
  })

  it('posts at most 3 a run and releases the overflow to the next run', async () => {
    const m = new ScriptedModel()
    const first = await runGuarded(db, m, 'r1', REPO_ROOT)
    expect(first.posted.map((p) => p.id)).toEqual([2, 4, 6])
    expect(first.deferred.map((p) => p.id)).toEqual([10])
    const second = await runGuarded(db, m, 'r2', REPO_ROOT)
    expect(second.posted.map((p) => p.id)).toEqual([10])
    expect(await count("SELECT count(*) FROM messages WHERE author = 'answer-bot'")).toBe(4)
  })

  it('a judge outage refuses and releases the claim, so a later run retries', async () => {
    const m = new ScriptedModel()
    m.judgeDown = true
    const r = await runGuarded(db, m, 'r1', REPO_ROOT)
    expect(r.posted).toEqual([])
    expect(r.refused.filter((x) => x.reason === 'judge_unavailable')).toHaveLength(5)
    m.judgeDown = false
    expect((await runGuarded(db, m, 'r2', REPO_ROOT)).posted).toHaveLength(3)
  })

  it('BROKEN posts the unsourced over-claim', async () => {
    const r = await runBroken(db, new ScriptedModel(), 'r1')
    expect(r.posted).toHaveLength(11)
    expect(r.posted.some((p) => p.id === 7 && !p.source)).toBe(true)
  })

  it('LIMIT: a confident, sourced, wrong answer passes', () => {
    const v = gate('rate limit?', { answer: '600 requests per minute.', confidence: 0.9, source: 'docs/api-limits.md' }, REPO_ROOT, new ScriptedModel())
    expect(v.post).toBe(true)
  })
})

describe('2. analyst loop', () => {
  const name = async () => (await db.query('SELECT name FROM accounts WHERE id = 12')).rows[0].name as string
  const runaway = async () => `Has "${await name()}"'s support load gone up?`

  it('stops at the budget, answers every tool_use in one message, and forces a conclusion with no tools', async () => {
    const m = new ScriptedModel()
    const seen: number[] = []
    const analyst = m.analyst.bind(m)
    m.analyst = (req) => (seen.push(req.tools.length), analyst(req))
    const r = await ask(db, m, await runaway())
    expect(r.outcome).toBe('forced')
    expect(r.toolCalls).toBe(TOOL_BUDGET)
    expect(() => checkTranscript(r.transcript)).not.toThrow()
    expect(seen.at(-1)).toBe(0)
    const last = r.transcript.at(-2)!
    expect(last.content.filter((b) => b.type === 'tool_result' && b.is_error)).toHaveLength(1)
    expect(last.content.at(-1)).toMatchObject({ type: 'text' })
  })

  it('BROKEN runs to the safety stop', async () => {
    expect((await askBroken(db, new ScriptedModel(), await runaway())).toolCalls).toBe(20)
  })

  it('a forced answer from partial reads says so in the reply', async () => {
    const names = (await db.query('SELECT name FROM accounts WHERE id <= 4 ORDER BY id')).rows.map((r) => `"${r.name}"`)
    const r = await ask(db, new ScriptedModel(), `What is the total open deal amount across ${names.join(', ')}?`)
    expect(r.outcome).toBe('forced')
    expect(r.toolCalls).toBe(6)
    expect(r.outcome === 'forced' && r.text.startsWith(FORCED_PREFIX)).toBe(true)
  })

  it('refuses tool_results split across messages (this repo\'s rule, stricter than the API)', () => {
    const t: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '[]' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '[]' }] },
    ]
    expect(() => checkTranscript(t)).toThrow(/without a tool_result.*b/)
  })

  it('a reply with a guess and a CLARIFY line is a clarify; the guess is dropped', async () => {
    expect(parseReply('It is 72.\nCLARIFY: Which field?')).toEqual({ kind: 'clarify', question: 'Which field?', dropped: 'It is 72.' })
    expect(parseReply('Two open deals.')).toEqual({ kind: 'answer', text: 'Two open deals.' })
    const r = await ask(db, new ScriptedModel(), `What is the health score for "${await name()}"?`)
    expect(r.outcome).toBe('clarify')
  })
})

describe('3. confirm before change', () => {
  const request = "Move Lee Marsh's EMEA accounts to Priya Raman."
  const lee = () => db.query(`SELECT id AS account_id, name, owner AS "from", 'Priya Raman' AS "to" FROM accounts WHERE owner = 'Lee Marsh' ORDER BY id`).then((r) => r.rows)

  it('refuses an edited list and applies only the stored one', async () => {
    const p = await propose(db, new ScriptedModel(), 's', request, true)
    expect(p.changes).toHaveLength(3)
    const edited = await confirm(db, { session_id: 's', turn_id: p.turn_id, confirmed: true, changes: await lee() })
    expect(edited).toMatchObject({ ok: false, reason: expect.stringMatching(/^list_mismatch/) })
    expect(await confirm(db, { session_id: 's', turn_id: p.turn_id, confirmed: true })).toMatchObject({ ok: true, applied: { length: 3 } })
    expect(await count("SELECT count(*) FROM accounts WHERE owner = 'Lee Marsh'")).toBe(7)
  })

  it('BROKEN applies whatever list arrives', async () => {
    const p = await propose(db, new ScriptedModel(), 's', request, true)
    await confirmBroken(db, { session_id: 's', turn_id: p.turn_id, confirmed: true, changes: await lee() })
    expect(await count("SELECT count(*) FROM accounts WHERE owner = 'Lee Marsh'")).toBe(0)
  })

  it('refuses a stale turn, a second confirmation, a non-interactive session, and a changed row', async () => {
    const m = new ScriptedModel()
    const t1 = await propose(db, m, 's', request, true)
    const t2 = await propose(db, m, 's', "Move Lee Marsh's NA accounts to Priya Raman.", true)
    expect(await confirm(db, { session_id: 's', turn_id: t1.turn_id, confirmed: true })).toEqual({ ok: false, reason: 'stale_turn' })
    await db.query("UPDATE accounts SET owner = 'Sam Whitlock' WHERE id = $1", [t2.changes[0]!.account_id])
    const r = await confirm(db, { session_id: 's', turn_id: t2.turn_id, confirmed: true })
    expect(r).toMatchObject({ ok: true, applied: { length: 3 }, refused: [{ reason: 'row_changed_since_shown' }] })
    expect(await confirm(db, { session_id: 's', turn_id: t2.turn_id, confirmed: true })).toEqual({ ok: false, reason: 'already_applied' })
    const s = await propose(db, m, 'cron', request, false)
    expect(await confirm(db, { session_id: 'cron', turn_id: s.turn_id, confirmed: true })).toEqual({ ok: false, reason: 'not_interactive' })
    expect(await confirm(db, { session_id: 's', turn_id: 'turn_made_up', confirmed: true })).toEqual({ ok: false, reason: 'unknown_turn' })
  })

  it('two confirmations that both read before either claims apply once', async () => {
    const p = await propose(db, new ScriptedModel(), 's', request, true)
    const msg = { session_id: 's', turn_id: p.turn_id, confirmed: true }
    // A barrier: neither proceeds past its read until both have read, so the race is forced.
    let arrived = 0
    let open!: () => void
    const both = new Promise<void>((r) => (open = r))
    const barrier = async (at: string) => {
      if (at !== 'read') return
      if (++arrived === 2) open()
      await both
    }
    const rs = await Promise.all([confirm(db, msg, barrier), confirm(db, msg, barrier)])
    expect(arrived).toBe(2)
    expect(rs.map((r) => (r.ok ? 'applied' : r.reason)).sort()).toEqual(['already_applied', 'applied'])
  })

  it('a newer proposal committed while a confirmation is in progress makes the old one stale', async () => {
    const m = new ScriptedModel()
    const old = await propose(db, m, 's', request, true)
    // The seam runs after confirm has read the proposal and before it claims it. The newer
    // proposal commits there, inside the window.
    const r = await confirm(db, { session_id: 's', turn_id: old.turn_id, confirmed: true }, async (at) => {
      if (at === 'read') await propose(db, m, 's', "Move Lee Marsh's NA accounts to Priya Raman.", true)
    })
    expect(r).toEqual({ ok: false, reason: 'stale_turn' })
    expect(await count("SELECT count(*) FROM accounts WHERE owner = 'Lee Marsh'")).toBe(10)
  })

  it('a proposal that arrives once the confirmation holds the session lock waits for it to commit', async () => {
    const m = new ScriptedModel()
    const old = await propose(db, m, 's', request, true)
    let newer: Promise<unknown> = Promise.resolve()
    let committed = false
    let committedInsideWindow = true
    const r = await confirm(db, { session_id: 's', turn_id: old.turn_id, confirmed: true }, async (at) => {
      if (at !== 'locked') return
      newer = propose(db, m, 's', "Move Lee Marsh's NA accounts to Priya Raman.", true).then(() => (committed = true))
      // Wait until the newer proposal has either committed or is queued on a lock.
      for (let i = 0; i < 100 && !committed; i++) {
        if (await count("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")) break
        await new Promise((res) => setTimeout(res, 10))
      }
      committedInsideWindow = committed
    })
    await newer
    // Serialised: the yes came before the newer proposal, so the old list applies and the newer
    // proposal is written after it. Without the lock, the newer one commits inside the window.
    expect(committedInsideWindow).toBe(false)
    expect(r).toMatchObject({ ok: true, applied: { length: 3 } })
  })

  it('two proposals at once in one session take turns: distinct turns, only the second is current', async () => {
    const m = new ScriptedModel()
    const [a, b] = await Promise.all([propose(db, m, 's', request, true), propose(db, m, 's', request, true)])
    expect(a.turn_id).not.toBe(b.turn_id)
    const seqs = (await db.query("SELECT seq FROM proposals WHERE session_id = 's' ORDER BY seq")).rows.map((r) => r.seq)
    expect(seqs).toEqual([1, 2])
  })

  it("a confirmation in session A does not wait on session B's proposal", async () => {
    const p = await propose(db, new ScriptedModel(), 'A', request, true)
    // Hold B's session lock the way propose does mid-transaction.
    const b = await db.connect()
    try {
      await b.query('BEGIN')
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['B'])
      const r = await Promise.race([
        confirm(db, { session_id: 'A', turn_id: p.turn_id, confirmed: true }),
        new Promise((res) => setTimeout(() => res('blocked'), 2000)),
      ])
      expect(r).toMatchObject({ ok: true, applied: { length: 3 } })
    } finally {
      await b.query('ROLLBACK')
      b.release()
    }
  })

  it('refuses a message that says it is unattended, and says which field of a list differs', async () => {
    const p = await propose(db, new ScriptedModel(), 's', request, true)
    expect(await confirm(db, { session_id: 's', turn_id: p.turn_id, confirmed: true, interactive: false })).toEqual({ ok: false, reason: 'not_interactive' })
    const edited = p.changes.map((c, i) => (i === 0 ? { ...c, to: 'Sam Whitlock' } : c))
    expect(mismatch(edited, p.changes)).toBe('same count, 1 row(s) differ in to')
    expect(mismatch(p.changes, p.changes)).toBeNull()
  })
})

describe('4. notes-only triage', () => {
  const ev = (id: string, subject: string) => JSON.stringify({ event_id: id, ticket_id: 900, subject, body: 'Started this week.' })

  it('the notes client has addNote and nothing else', () => {
    const c = notesClient(db)
    expect(Object.keys(c)).toEqual(['addNote'])
    // @ts-expect-error there is no reply method; `pnpm test` runs tsc first, so this line must stay an error
    expect(c.reply).toBeUndefined()
  })

  it('a redelivered event produces one note, and nothing reaches the customer', async () => {
    for (const id of ['e1', 'e1', 'e2', 'e1']) expect(await receive(db, ev(id, 'Sync stopped updating overnight'))).toBe(200)
    expect(await receive(db, 'not json')).toBe(400)
    await work(db, new ScriptedModel())
    await receive(db, ev('e1', 'Sync stopped updating overnight'))
    await work(db, new ScriptedModel())
    expect(await count("SELECT count(*) FROM ticket_messages WHERE visibility = 'internal'")).toBe(2)
    expect(await count("SELECT count(*) FROM ticket_messages WHERE visibility = 'customer'")).toBe(0)
    expect(await count("SELECT count(*) FROM ledger WHERE outcome = 'not sent: client has no reply method'")).toBeGreaterThan(0)
  })

  it('BROKEN: with a reply method and a prompt that forbids it, the customer gets a message', async () => {
    await receive(db, ev('e1', 'Sync stopped updating overnight'))
    await workBroken(db, new ScriptedModel(), fullClient(db))
    expect(await count("SELECT count(*) FROM ticket_messages WHERE visibility = 'customer'")).toBe(1)
  })

  it('the note is a customer-side check from past tickets, never the staff fix, with one question', async () => {
    const matches = await similar(db, 'Our sync stopped updating and the dashboard is stuck')
    expect(matches[0]?.cause).toMatch(/expired connection token/)
    const note = composeNote(matches, matches[0]!.id, 'When did it stop? Was anything changed?')
    expect(note).toMatch(/This is usually .* Check /)
    expect(note).not.toContain(matches[0]!.staff_fix)
    expect(note.match(/\?/g)).toHaveLength(1)
    expect(composeNote(matches, 9999, 'Why?')).toContain('No past ticket is close enough')
    expect(oneQuestion('No question here.')).toMatch(/\?$/)
  })
})

it('the ledger has a row for every action', async () => {
  await runGuarded(db, new ScriptedModel(), 'r1', REPO_ROOT)
  expect(await count("SELECT count(*) FROM ledger WHERE agent = 'questions' AND at >= '2026'")).toBeGreaterThanOrEqual(11)
})
