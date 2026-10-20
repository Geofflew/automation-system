/**
 * Agent 3: reassigns account owners, but only what a person confirmed.
 *
 * The protocol: the agent proposes an exact list with a turn_id; the server stores it; the client
 * sends back the turn_id with the person's yes; the server applies the STORED list. The list in the
 * confirmation message is never the thing applied. It is compared, and a different list is refused.
 */
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { record, type Db } from './db.ts'
import type { ScriptedModel } from './model.ts'

export type Change = { account_id: number; name: string; from: string; to: string }
export type Proposal = { turn_id: string; changes: Change[] }
export type Confirmation = { session_id: string; turn_id: string; confirmed: boolean; changes?: Change[]; interactive?: boolean }
export type Applied = { ok: true; applied: Change[]; refused: { change: Change; reason: string }[] } | { ok: false; reason: string }

const key = (cs: Change[]) => JSON.stringify(cs.map((c) => [c.account_id, c.to]).sort())

/** Null when the lists agree; otherwise what differs, so the person hears more than "mismatch". */
export function mismatch(sent: Change[], stored: Change[]): string | null {
  if (key(sent) === key(stored)) return null
  if (sent.length !== stored.length) return `${sent.length} sent, ${stored.length} stored`
  const byId = new Map(stored.map((c) => [c.account_id, c]))
  const unknown = sent.filter((c) => !byId.has(c.account_id)).length
  if (unknown) return `same count, ${unknown} row(s) differ in account_id`
  return `same count, ${sent.filter((c) => byId.get(c.account_id)!.to !== c.to).length} row(s) differ in to`
}

/** The agent: the model reads the request into a filter; the rows come from the database. */
export async function propose(pool: pg.Pool, model: ScriptedModel, sessionId: string, request: string, interactive: boolean): Promise<Proposal> {
  const plan = model.plan(request)
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    // The session lock: proposing and confirming in one session take turns, so a confirmation can
    // never claim a turn while a newer one is being written. Other sessions use other keys.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionId])
    const { rows } = await db.query(
      `SELECT id AS account_id, name, owner AS "from", $2::text AS "to" FROM accounts WHERE owner = $1 AND ($3::text IS NULL OR region = $3) ORDER BY id`,
      [plan.from, plan.to, plan.region ?? null],
    )
    const seq = (await db.query('SELECT count(*)::int + 1 AS n FROM proposals WHERE session_id = $1', [sessionId])).rows[0].n as number
    const turn_id = `turn_${createHash('sha256').update(`${sessionId}:${seq}`).digest('hex').slice(0, 10)}`
    // A scheduled run has no person to confirm. The proposal is recorded so the ledger shows what it
    // would have done, and it can never be applied.
    const status = interactive ? 'pending' : 'refused_not_interactive'
    await db.query('INSERT INTO proposals (turn_id, session_id, seq, changes, interactive, status) VALUES ($1, $2, $3, $4, $5, $6)', [
      turn_id, sessionId, seq, JSON.stringify(rows), interactive, status,
    ])
    await record(db, 'changes', sessionId, 'propose', { request, rows }, `${rows.length} change(s), ${status}`)
    await db.query('COMMIT')
    return { turn_id, changes: rows }
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    db.release()
  }
}

/**
 * GUARDED. Refuses: an unknown turn, a non-interactive session, a confirmation whose list differs
 * from the stored one, a superseded turn, a turn already applied. Then re-checks each row against what the
 * person was shown and applies the stored list, all in one transaction.
 */
export async function confirm(pool: pg.Pool, msg: Confirmation, seam?: (at: 'read' | 'locked') => Promise<void>): Promise<Applied> {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const refuse = async (reason: string): Promise<Applied> => {
      await db.query('ROLLBACK')
      await record(pool, 'changes', msg.session_id, 'apply', msg, `refused: ${reason}`)
      return { ok: false, reason }
    }
    const p = (await db.query('SELECT * FROM proposals WHERE turn_id = $1 AND session_id = $2', [msg.turn_id, msg.session_id])).rows[0]
    if (!p) return refuse('unknown_turn')
    if (msg.interactive === false || !p.interactive) return refuse('not_interactive')
    if (!msg.confirmed) return refuse('not_confirmed')
    const stored = p.changes as Change[]
    const diff = msg.changes ? mismatch(msg.changes, stored) : null
    if (diff) return refuse(`list_mismatch: ${diff}`)
    await seam?.('read') // test seam: anything that happens between reading the proposal and claiming it
    // The latest-turn check and the claim run under the session lock propose also takes. A newer
    // proposal either committed before the lock (and is seen here) or waits until this commits.
    // Without the lock, one committed between the check and the claim goes unseen.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [msg.session_id])
    const latest = (await db.query('SELECT max(seq) AS s FROM proposals WHERE session_id = $1', [msg.session_id])).rows[0].s
    if (p.seq !== latest) return refuse('stale_turn')
    await seam?.('locked') // test seam: a proposal arriving now must wait for this to commit
    // The claim is one compare-and-set statement, not a read then a write. Of two confirmations
    // racing, the second waits on the lock, then finds the proposal no longer pending.
    const claim = await db.query("UPDATE proposals SET status = 'applied' WHERE turn_id = $1 AND status = 'pending'", [msg.turn_id])
    if (claim.rowCount === 0) return refuse('already_applied')

    const applied: Change[] = []
    const refused: { change: Change; reason: string }[] = []
    for (const c of stored) {
      // Only if the row still has the owner the person saw; someone else may have moved it since.
      const r = await db.query('UPDATE accounts SET owner = $1 WHERE id = $2 AND owner = $3', [c.to, c.account_id, c.from])
      if (r.rowCount === 1) applied.push(c)
      else refused.push({ change: c, reason: 'row_changed_since_shown' })
    }
    await record(db, 'changes', msg.session_id, 'apply', { turn_id: msg.turn_id, stored }, `applied ${applied.length}, refused ${refused.length}`)
    await db.query('COMMIT')
    return { ok: true, applied, refused }
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    db.release()
  }
}

/** BROKEN: "confirmed" plus a list is enough. Whatever list arrives is applied. */
export async function confirmBroken(db: Db, msg: Confirmation): Promise<Applied> {
  if (!msg.confirmed || !msg.changes) return { ok: false, reason: 'not_confirmed' }
  for (const c of msg.changes) await db.query('UPDATE accounts SET owner = $1 WHERE id = $2', [c.to, c.account_id])
  await record(db, 'changes', msg.session_id, 'apply', msg, `applied ${msg.changes.length} (list from the message)`)
  return { ok: true, applied: msg.changes, refused: [] }
}
