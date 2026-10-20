/**
 * Agent 1: answers product questions people leave unanswered in a chat channel.
 *
 * The drafter (a model) returns an answer, a confidence and a source path. This file is the app's
 * refusal to post: it assumes the drafter may be wrong and declines anything it cannot verify.
 * The bar is high on purpose. The two errors are not the same size: a wrong answer gets passed on
 * to a prospect as fact, and an unanswered question just waits for a person, as it did before.
 */
import { existsSync, statSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'
import { record, type Db } from './db.ts'
import type { Draft, ScriptedModel } from './model.ts'

export const MAX_POSTS_PER_RUN = 3
export const MIN_CONFIDENCE = 0.8
export const BOT = 'answer-bot'
export const DRAFT_PROMPT = 'Answer only when you are sure, from the product repo, and name the file. Otherwise say nothing.'

export type Refusal =
  | 'empty_answer' | 'no_confidence' | 'low_confidence' | 'no_source' | 'source_not_found'
  | 'hedged' | 'announces' | 'off_question'
  // Not the model misbehaving: the judge could not be asked. Retryable, so the claim is released.
  | 'judge_unavailable'

// A phrase list is blunt and that is the point: free, run on every answer, and when it over-fires
// the ledger shows which phrase did it.
const HEDGES = [
  /\bi'?m not (sure|certain)\b/, /\b(i|we) (think|believe|suspect)\b/, /\b(probably|likely|maybe|perhaps|possibly)\b/,
  /\b(appears|seems) to\b/, /\b(it|this|that) (appears|seems)\b/, /\bas far as (i|we) can tell\b/, /\b(i|we) (couldn't|could not|can't|cannot) find\b/,
  /\bunclear\b/, /\bworth (checking|confirming)\b/, /\bshould (support|work|be able to)\b/,
]
// Nobody asked the bot, so a message that announces work is an interruption. The answer or nothing.
const ANNOUNCES = [/\b(let me|i'll) (look|check|dig)\b/, /\bfor you\b/, /\b(great|good) question\b/, /\bhope this helps\b/, /\blet me know if\b/]

/** Models write U+2019; the patterns are ASCII. Without this, "I’m not certain" passes. */
export const normalise = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase()

/** A source must be a file inside the product repo. `../../etc/hosts` exists, and is not a source. */
export function sourceExists(repoRoot: string, source: string): boolean {
  const full = resolve(repoRoot, source)
  const rel = relative(repoRoot, full)
  return !rel.startsWith('..') && !isAbsolute(rel) && existsSync(full) && statSync(full).isFile()
}

/** The checks that cost nothing, in order. Returns the first reason to refuse, or null. */
export function cheapChecks(draft: Draft, repoRoot: string): Refusal | null {
  if (typeof draft.answer !== 'string' || draft.answer.trim() === '') return 'empty_answer'
  if (typeof draft.confidence !== 'number' || Number.isNaN(draft.confidence)) return 'no_confidence'
  if (draft.confidence < MIN_CONFIDENCE) return 'low_confidence'
  if (typeof draft.source !== 'string' || draft.source.trim() === '') return 'no_source'
  if (!sourceExists(repoRoot, draft.source)) return 'source_not_found'
  const text = normalise(draft.answer)
  if (HEDGES.some((p) => p.test(text))) return 'hedged'
  if (ANNOUNCES.some((p) => p.test(text))) return 'announces'
  return null
}

export type Verdict = { post: true } | { post: false; reason: Refusal }

/** The cheap checks, then one model call to judge relevance, spent only on drafts that survived. */
export function gate(question: string, draft: Draft, repoRoot: string, model: ScriptedModel): Verdict {
  const reason = cheapChecks(draft, repoRoot)
  if (reason) return { post: false, reason }
  try {
    return model.judge(question, draft.answer as string).addresses ? { post: true } : { post: false, reason: 'off_question' }
  } catch {
    return { post: false, reason: 'judge_unavailable' }
  }
}

/** Questions with no reply in their thread, not yet claimed. The insert is the claim. */
export async function scan(db: Db, runId: string): Promise<{ id: number; text: string }[]> {
  const { rows } = await db.query(
    `INSERT INTO question_claims (message_id, run_id)
     SELECT m.id, $1 FROM messages m
     WHERE m.text LIKE '%?%' AND m.reply_to IS NULL AND m.author <> $2
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
     ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
    [runId, BOT],
  )
  const ids = rows.map((r) => r.message_id as number)
  return (await db.query('SELECT id, text FROM messages WHERE id = ANY($1) ORDER BY id', [ids])).rows
}

export type RunResult = {
  posted: { id: number; question: string; answer: string; source?: string }[]
  refused: { id: number; question: string; reason: Refusal }[]
  deferred: { id: number; question: string }[]
}

async function post(db: Db, id: number, answer: string, source?: string) {
  await db.query('INSERT INTO messages (ts, author, text, reply_to) VALUES ($1, $2, $3, $4)', ['10:00', BOT, source ? `${answer} (source: ${source})` : answer, id])
}

/** BROKEN: the limit lives in the drafter's prompt ("only answer when sure"). Everything posts. */
export async function runBroken(db: Db, model: ScriptedModel, runId: string): Promise<RunResult> {
  const out: RunResult = { posted: [], refused: [], deferred: [] }
  for (const q of await scan(db, runId)) {
    const d = model.draft(q.text, DRAFT_PROMPT)
    const answer = String(d.answer ?? '')
    await post(db, q.id, answer, d.source as string | undefined)
    await record(db, 'questions', BOT, 'post', { q: q.id, d }, 'posted (no gate)')
    out.posted.push({ id: q.id, question: q.text, answer, source: d.source as string | undefined })
  }
  return out
}

/** GUARDED: every draft passes the gate; at most MAX_POSTS_PER_RUN post; the rest wait for the next run. */
export async function runGuarded(db: Db, model: ScriptedModel, runId: string, repoRoot: string): Promise<RunResult> {
  const out: RunResult = { posted: [], refused: [], deferred: [] }
  for (const q of await scan(db, runId)) {
    const d = model.draft(q.text, DRAFT_PROMPT)
    const v = gate(q.text, d, repoRoot, model)
    if (!v.post) {
      // A refusal is final for this question, except an outage, which a later run retries.
      if (v.reason === 'judge_unavailable') await db.query('DELETE FROM question_claims WHERE message_id = $1', [q.id])
      else await db.query("UPDATE question_claims SET status = 'refused', reason = $2 WHERE message_id = $1", [q.id, v.reason])
      await record(db, 'questions', BOT, 'refuse', { q: q.id, d }, v.reason)
      out.refused.push({ id: q.id, question: q.text, reason: v.reason })
      continue
    }
    if (out.posted.length >= MAX_POSTS_PER_RUN) {
      // Over the cap: reported and released, never dropped. The next run claims it again.
      await db.query('DELETE FROM question_claims WHERE message_id = $1', [q.id])
      await record(db, 'questions', BOT, 'defer', { q: q.id }, `over cap of ${MAX_POSTS_PER_RUN}`)
      out.deferred.push({ id: q.id, question: q.text })
      continue
    }
    await post(db, q.id, d.answer as string, d.source as string)
    await db.query("UPDATE question_claims SET status = 'posted' WHERE message_id = $1", [q.id])
    await record(db, 'questions', BOT, 'post', { q: q.id, d }, 'posted')
    out.posted.push({ id: q.id, question: q.text, answer: d.answer as string, source: d.source as string })
  }
  return out
}
