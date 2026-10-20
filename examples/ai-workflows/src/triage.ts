/**
 * Agent 4: support triage that writes internal notes and nothing else.
 *
 * A webhook receiver stores the raw event and returns 200. A worker picks events up, finds the
 * closest past tickets, and writes one internal note: the likeliest customer-side cause as a check,
 * and one question. The client it is given has `addNote` and no other method, so "never reply to
 * the customer" is not an instruction the model can ignore. There is nothing to call.
 */
import type pg from 'pg'
import { record, type Db } from './db.ts'
import type { ScriptedModel } from './model.ts'

/** GUARDED client: the only write the worker can make. */
export interface NotesClient {
  addNote(ticketId: number, body: string, idempotencyKey: string): Promise<void>
}

/** BROKEN client: the support tool's whole surface, including the customer-visible reply. */
export interface FullClient extends NotesClient {
  reply(ticketId: number, body: string): Promise<void>
}

export function notesClient(db: Db): NotesClient {
  return {
    async addNote(ticketId, body, idempotencyKey) {
      // The key makes a retried write a no-op, so a crash between note and bookkeeping cannot double-post.
      await db.query("INSERT INTO ticket_messages (ticket_id, visibility, body, event_id) VALUES ($1, 'internal', $2, $3) ON CONFLICT (event_id) DO NOTHING", [ticketId, body, idempotencyKey])
    },
  }
}

export function fullClient(db: Db): FullClient {
  return {
    ...notesClient(db),
    async reply(ticketId, body) {
      await db.query("INSERT INTO ticket_messages (ticket_id, visibility, body) VALUES ($1, 'customer', $2)", [ticketId, body])
    },
  }
}

/** The receiver: store the raw body under its event id and return 200. A redelivery is a no-op. */
export async function receive(db: Db, raw: string): Promise<number> {
  let id: unknown
  try {
    id = JSON.parse(raw).event_id
  } catch {}
  if (typeof id !== 'string') return 400
  await db.query('INSERT INTO webhook_events (event_id, raw) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING', [id, raw])
  return 200
}

// ---- similarity: plain word overlap, no embeddings -----------------------------------------

const STOP = new Set(['the', 'and', 'for', 'our', 'has', 'have', 'not', 'since', 'with', 'this', 'that', 'are', 'was', 'from', 'all', 'any', 'can', 'get', 'its', 'but'])
export const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [])

export type Match = { id: number; score: number; cause: string; customer_check: string; staff_fix: string }

/** Jaccard overlap of word sets against every resolved ticket; the top 3 at or above `min`. */
export async function similar(db: Db, text: string, min = 0.2): Promise<Match[]> {
  const q = words(text)
  const { rows } = await db.query("SELECT id, subject, body, cause, customer_check, staff_fix FROM tickets WHERE status = 'resolved'")
  return rows
    .map((r) => {
      const w = words(`${r.subject} ${r.body}`)
      const inter = [...q].filter((x) => w.has(x)).length
      return { id: r.id, score: Math.round((inter / (q.size + w.size - inter)) * 100) / 100, cause: r.cause, customer_check: r.customer_check, staff_fix: r.staff_fix }
    })
    .filter((m) => m.score >= min)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, 3)
}

/** Exactly one question: the first sentence that ends in "?", or a fixed one if there is none. */
export function oneQuestion(s: string): string {
  return /[^?.!]*\?/.exec(s)?.[0]?.trim() ?? 'What changed on your side just before this started?'
}

/**
 * The note is composed by code from the corpus row the model picked, so its cause line is always
 * the customer-side cause and check, phrased as "usually", never the staff fix and never a verdict.
 */
export function composeNote(matches: Match[], pickedId: number | null, question: string): string {
  const m = matches.find((x) => x.id === pickedId) // a pick outside the retrieved set is ignored
  const same = m ? matches.filter((x) => x.cause === m.cause).length : 0
  const cause = m
    ? `This is usually ${m.cause} (${same} of the ${matches.length} closest past tickets). Check ${m.customer_check}.`
    : 'No past ticket is close enough to suggest a cause.'
  const refs = matches.map((x) => `#${x.id} (${x.score})`).join(', ') || 'none'
  return `[triage, internal note]\n${cause}\nAsk the customer: ${oneQuestion(question)}\nClosest past tickets: ${refs}`
}

const NOTE_PROMPT = 'Pick the past ticket that matches, if any, and ask the customer one question.'

type Event = { event_id: string; ticket_id: number; subject: string; body: string }

async function next(db: pg.PoolClient): Promise<{ event_id: string; raw: string } | undefined> {
  return (await db.query('SELECT event_id, raw FROM webhook_events WHERE processed_at IS NULL ORDER BY event_id LIMIT 1 FOR UPDATE SKIP LOCKED')).rows[0]
}

/**
 * GUARDED worker. It is not handed a client; it builds the notes-only one itself, so no caller can
 * pass it something wider, and `client.reply` does not compile.
 */
export async function work(pool: pg.Pool, model: ScriptedModel): Promise<number> {
  let done = 0
  for (;;) {
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const row = await next(db)
      if (!row) {
        await db.query('COMMIT')
        return done
      }
      const e = JSON.parse(row.raw) as Event
      const client = notesClient(db)
      const matches = await similar(db, `${e.subject} ${e.body}`)
      const t = model.triage(NOTE_PROMPT, e.subject, matches)
      await client.addNote(e.ticket_id, composeNote(matches, t.match_id, t.question), e.event_id)
      await record(db, 'triage', 'triage-worker', 'add_note', e, `note on ticket ${e.ticket_id}`)
      // The model also wrote a reply. There is no method to send it; the ledger says so.
      if (t.reply) await record(db, 'triage', 'triage-worker', 'reply', { e, reply: t.reply }, 'not sent: client has no reply method')
      await db.query('UPDATE webhook_events SET processed_at = $1 WHERE event_id = $2', ['done', e.event_id])
      await db.query('COMMIT')
      done++
    } catch (err) {
      await db.query('ROLLBACK')
      throw err
    } finally {
      db.release()
    }
  }
}

/** BROKEN worker: holds the full client; the prompt says "do not reply to the customer". */
export const BROKEN_PROMPT = 'Triage the ticket. Write an internal note. Do not reply to the customer.'
export async function workBroken(pool: pg.Pool, model: ScriptedModel, client: FullClient): Promise<number> {
  const { rows } = await pool.query("UPDATE webhook_events SET processed_at = 'done' WHERE processed_at IS NULL RETURNING raw")
  for (const { raw } of rows) {
    const e = JSON.parse(raw) as Event
    const t = model.triage(BROKEN_PROMPT, e.subject, await similar(pool, `${e.subject} ${e.body}`))
    if (t.reply) {
      await client.reply(e.ticket_id, t.reply)
      await record(pool, 'triage', 'triage-worker', 'reply', { e, reply: t.reply }, 'sent to customer')
    }
  }
  return rows.length
}
