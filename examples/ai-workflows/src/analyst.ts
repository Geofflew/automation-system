/**
 * Agent 2: a read-only analyst. A tool-use loop over three tools against Postgres.
 *
 * The limits are in the loop, not the prompt: a budget of tool calls per question, a forced
 * conclusion when it trips, and a reply protocol a parser enforces.
 */
import type pg from 'pg'
import { record } from './db.ts'
import type { Message, ScriptedModel, Tool, ToolResult, ToolUse } from './model.ts'

export const TOOL_BUDGET = 6

// The descriptions are the field dictionary. A field that is not defined here does not exist.
export const TOOLS: Tool[] = [
  { name: 'find_account', description: 'Find an account by exact name. Returns id, name, owner (the rep who owns the account) and region (NA, EMEA or APAC).' },
  { name: 'list_deals', description: 'Deals for an account_id. stage is open, won or lost; amount is the annual contract value in whole dollars; closes_on is the expected or actual close date.' },
  { name: 'list_tickets', description: 'Support tickets for an account_id, filtered by status (open or resolved). priority is low, normal or urgent; opened_on is the day the customer opened it.' },
]

export const SYSTEM =
  'You answer questions about Acme accounts using only the tools. Reply with an answer, or with a first line ' +
  '"CLARIFY: <one question>" if the question names something the tools do not define. Never both.'

const SQL: Record<string, string> = {
  find_account: 'SELECT id, name, owner, region FROM accounts WHERE name = $1',
  list_deals: 'SELECT id, stage, amount, closes_on FROM deals WHERE account_id = $1 ORDER BY id',
  list_tickets: 'SELECT id, subject, priority, opened_on FROM tickets WHERE account_id = $1 AND status = $2 ORDER BY id',
}

/** Runs one tool call read-only. Errors become an error result, never a thrown loop. */
export async function runTool(pool: pg.Pool, use: ToolUse): Promise<ToolResult> {
  const sql = SQL[use.name]
  if (!sql) return { type: 'tool_result', tool_use_id: use.id, content: `unknown tool ${use.name}`, is_error: true }
  const params = use.name === 'find_account' ? [use.input.name] : use.name === 'list_deals' ? [use.input.account_id] : [use.input.account_id, use.input.status ?? 'open']
  const db = await pool.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const { rows } = await db.query(sql, params)
    await db.query('COMMIT')
    return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(use.name === 'find_account' ? (rows[0] ?? null) : rows) }
  } catch (e) {
    await db.query('ROLLBACK')
    return { type: 'tool_result', tool_use_id: use.id, content: String(e), is_error: true }
  } finally {
    db.release()
  }
}

export type Reply = { kind: 'answer'; text: string } | { kind: 'clarify'; question: string; dropped?: string }

/**
 * The protocol: the first line is exactly `CLARIFY: ...` or the reply is an answer. A reply that
 * carries both is a guess dressed up next to a question, so CLARIFY wins and the rest is dropped.
 */
export function parseReply(text: string): Reply {
  const lines = text.trim().split('\n')
  const i = lines.findIndex((l) => l.startsWith('CLARIFY:'))
  if (i === -1) return { kind: 'answer', text: text.trim() }
  const rest = lines.filter((_, j) => j !== i).join('\n').trim()
  return { kind: 'clarify', question: lines[i]!.slice('CLARIFY:'.length).trim(), ...(rest ? { dropped: rest } : {}) }
}

export type Outcome =
  | { outcome: 'answer'; text: string }
  | { outcome: 'clarify'; question: string; dropped?: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'forced'; text: string }
  | { outcome: 'runaway'; text: string }

export type AskResult = Outcome & { toolCalls: number; transcript: Message[] }

export const FORCED_PREFIX = `Budget of ${TOOL_BUDGET} tool calls spent; answer based on what was read:`
const BUDGET_SPENT = `Not run: the tool budget for this question (${TOOL_BUDGET} calls) is spent.`
const CONCLUDE = `The tool budget is spent (${TOOL_BUDGET} of ${TOOL_BUDGET}). Answer now from the results above, ` +
  'or reply with a first line CLARIFY: and one question. No more tools are available.'

function finish(text: string, forced: boolean): Outcome {
  const reply = parseReply(text)
  if (reply.kind === 'clarify') return { outcome: 'clarify', question: reply.question, ...(reply.dropped ? { dropped: reply.dropped } : {}) }
  // A forced answer may rest on partial reads; the reply itself says so, whatever the model wrote.
  return forced ? { outcome: 'forced', text: `${FORCED_PREFIX} ${reply.text}` } : { outcome: 'answer', text: reply.text }
}

/** GUARDED: the loop owns the budget. The model is never asked to count. */
export async function ask(db: pg.Pool, model: ScriptedModel, question: string): Promise<AskResult> {
  const transcript: Message[] = [{ role: 'user', content: [{ type: 'text', text: question }] }]
  let used = 0
  for (;;) {
    const forced = used >= TOOL_BUDGET
    const reply = model.analyst({ system: SYSTEM, tools: forced ? [] : TOOLS, messages: transcript })
    transcript.push(reply)
    const uses = reply.content.filter((b): b is ToolUse => b.type === 'tool_use')
    const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (forced && uses.length) return done({ outcome: 'refused', reason: 'asked for tools after the budget was spent' })
    if (!uses.length) return done(finish(text, forced))

    // Every tool_use is answered, in this one message, even the ones over budget: a tool_use left
    // without its tool_result makes the next request invalid, and one message keeps parallel calls.
    const results: ToolResult[] = []
    for (const u of uses) {
      if (used < TOOL_BUDGET) {
        used++
        results.push(await runTool(db, u))
      } else results.push({ type: 'tool_result', tool_use_id: u.id, content: BUDGET_SPENT, is_error: true })
    }
    transcript.push({ role: 'user', content: used >= TOOL_BUDGET ? [...results, { type: 'text', text: CONCLUDE }] : results })
  }
  async function done(o: Outcome): Promise<AskResult> {
    await record(db, 'analyst', 'analyst', 'answer', { question }, `${o.outcome} after ${used} tool call(s)`)
    return { ...o, toolCalls: used, transcript }
  }
}

/** BROKEN: the budget is a sentence in the prompt. The loop stops only at a demo safety stop of 20. */
export async function askBroken(db: pg.Pool, model: ScriptedModel, question: string, stop = 20): Promise<AskResult> {
  const transcript: Message[] = [{ role: 'user', content: [{ type: 'text', text: question }] }]
  const system = `${SYSTEM} Use at most ${TOOL_BUDGET} tool calls.`
  let used = 0
  while (used < stop) {
    const reply = model.analyst({ system, tools: TOOLS, messages: transcript })
    transcript.push(reply)
    const uses = reply.content.filter((b): b is ToolUse => b.type === 'tool_use')
    if (!uses.length) {
      const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
      await record(db, 'analyst', 'analyst', 'answer', { question }, `answer after ${used} tool call(s), no checks`)
      return { outcome: 'answer', text, toolCalls: used, transcript }
    }
    const results: ToolResult[] = []
    for (const u of uses) {
      if (used >= stop) break
      used++
      results.push(await runTool(db, u))
    }
    transcript.push({ role: 'user', content: results })
  }
  await record(db, 'analyst', 'analyst', 'answer', { question }, `runaway: stopped at ${used} tool calls`)
  return { outcome: 'runaway', text: '', toolCalls: used, transcript }
}
