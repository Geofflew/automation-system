/**
 * The model, scripted. Every model call in the repo goes through ScriptedModel, so the demo and the
 * tests need no key and print the same thing every run. Each script is written to misbehave in the
 * one way the guard beside it exists to catch: an unsourced over-claim, a tool loop that never
 * stops, a guess next to a clarifying question, a confirmation relayed with a longer list, a reply
 * sent to a customer after the prompt said not to. The guards never read these scripts; they see
 * only what a real model call would return.
 */

// ---- 1. product questions ------------------------------------------------------------------

/** What the drafter returns. Fields are `unknown` because a model's JSON is untrusted. */
export type Draft = { answer?: unknown; confidence?: unknown; source?: unknown }

const DRAFTS: Record<string, Draft> = {
  'Can a customer export the audit log to CSV? Their controller asked on the call.': {
    answer: 'Yes. An admin can export the audit log as CSV from Settings, Audit log. The export covers the last 365 days.',
    confidence: 0.92, source: 'docs/audit-log.md',
  },
  'Does SSO include SCIM provisioning, or is that separate?': {
    answer: 'It is included. SCIM 2.0 provisioning comes with SAML SSO on the Enterprise plan.', confidence: 0.9, source: 'docs/sso.md',
  },
  // Confident, sourced and wrong: the file says 300. No check in the gate reads the file.
  "What's the API rate limit per workspace? The prospect plans a nightly pull.": {
    answer: '600 requests per minute per workspace. Over that the API returns 429.', confidence: 0.88, source: 'docs/api-limits.md',
  },
  'Can approvals require two reviewers before a period is locked?': {
    answer: 'Yes. An approval rule can require two reviewers, and the period cannot lock until both approve.', confidence: 0.9, source: 'docs/approvals.md',
  },
  // The over-claim: very confident, no source, and a commitment nobody can back.
  'Are we SOC 2 Type II certified, and do we guarantee 99.99% uptime?': {
    answer: 'Yes on both. We are SOC 2 Type II certified and we guarantee 99.99% uptime in every contract.', confidence: 0.97,
  },
  'Does the warehouse connector support BigQuery?': {
    answer: 'Yes. BigQuery is supported as a warehouse connector with hourly sync.', confidence: 0.86, source: 'docs/integrations/bigquery.md',
  },
  "Who has the slides from Tuesday's demo?": { answer: 'The slides are in the shared deal folder.' },
  'Is data retention configurable per customer?': {
    answer: 'Yes, retention can be set per customer.', confidence: 0.4, source: 'docs/data-retention.md',
  },
  // A typographic apostrophe, as models write them. The hedge list is written with ASCII quotes.
  'Do we have a way to restrict exports by role?': {
    answer: 'I’m not certain, but admins can restrict exports to chosen roles.', confidence: 0.82, source: 'docs/permissions.md',
  },
  'Can someone confirm the export size limit?': {
    answer: 'Great question! Let me look into that for you. An export file holds at most 1,000,000 rows.', confidence: 0.9, source: 'docs/exports.md',
  },
  // Sourced, confident, plain, and about something else.
  "Does the retention policy apply to deleted users' data?": {
    answer: 'An export file holds at most 1,000,000 rows; larger exports are split.', confidence: 0.9, source: 'docs/exports.md',
  },
}
const OFF_QUESTION = new Set(["Does the retention policy apply to deleted users' data?"])

// ---- 2. analyst: Anthropic-shaped messages ---------------------------------------------------

export type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type Block = { type: 'text'; text: string } | ToolUse | ToolResult
export type Message = { role: 'user' | 'assistant'; content: Block[] }
export type Tool = { name: string; description: string }
export type AnalystRequest = { system: string; tools: Tool[]; messages: Message[] }

/**
 * Two rules, checked on every analyst call. The API's own: a tool_use with no tool_result in the
 * following user turn is an invalid request. This repo's stricter one: all of a turn's results go
 * in that one message. The API merges consecutive user messages, so it would likely accept a split;
 * this check refuses it anyway, because results sent one per message train the model to stop
 * making parallel calls.
 */
export function checkTranscript(messages: Message[]): void {
  messages.forEach((m, i) => {
    const ids = m.role === 'assistant' ? m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : []
    if (ids.length === 0) return
    const next = messages[i + 1]
    const answered = new Set(next?.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])) ?? [])
    const missing = ids.filter((id) => !answered.has(id))
    if (missing.length) throw new Error(`400 invalid_request: tool_use ids without a tool_result in the next message: ${missing.join(', ')}`)
  })
}

// ---- 3. changes ------------------------------------------------------------------------------

export type Reassign = { from: string; region?: string; to: string }

// ---- 4. triage -------------------------------------------------------------------------------

export type Triage = { match_id: number | null; question: string; reply: string }

export class ScriptedModel {
  calls = 0
  judgeDown = false

  /** The prompt is passed and, like a model having a bad day, not obeyed. */
  draft(question: string, _prompt: string): Draft {
    this.calls++
    return DRAFTS[question] ?? {}
  }

  /** The one model call in the gate: does this answer address this question? */
  judge(question: string, _answer: string): { addresses: boolean } {
    this.calls++
    if (this.judgeDown) throw new Error('judge unavailable')
    return { addresses: !OFF_QUESTION.has(question) }
  }

  analyst(req: AnalystRequest): Message {
    this.calls++
    // A loop that never stops would spin here without awaiting anything; fail it instead.
    if (this.calls > 50) throw new Error('scripted analyst: more than 50 calls, the loop is not stopping')
    checkTranscript(req.messages)
    const first = req.messages[0]!.content[0]
    const question = first?.type === 'text' ? first.text : ''
    const name = /"([^"]+)"/.exec(question)?.[1] ?? ''
    const results = req.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' && !b.is_error ? [JSON.parse(b.content)] : [])))
    const used = req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use')).length
    const account = results[0] as { id: number; name: string } | undefined
    const use = (tool: string, input: Record<string, unknown>, k = 0): ToolUse => ({ type: 'tool_use', id: `tu_${used + k + 1}`, name: tool, input })
    const say = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
    const calls = (...uses: ToolUse[]): Message => ({ role: 'assistant', content: uses })

    // Needs 8 calls (4 lookups, 4 deal lists); asks for them 4 at a time.
    if (/total open deal amount/.test(question)) {
      const names = [...question.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
      if (used === 0) return calls(...names.map((n, k) => use('find_account', { name: n }, k)))
      if (req.tools.length > 0) return calls(...(results as { id: number }[]).map((a, k) => use('list_deals', { account_id: a.id }, k)))
      const lists = results.slice(names.length) as { stage: string; amount: number }[][]
      const total = lists.flat().filter((d) => d.stage === 'open').reduce((s, d) => s + d.amount, 0)
      return say(`Total open deal amount: $${total}.`)
    }

    if (used === 0) return calls(use('find_account', { name }))

    if (/open deals/.test(question)) {
      if (used === 1) return calls(use('list_deals', { account_id: account!.id }), use('list_tickets', { account_id: account!.id, status: 'open' }, 1))
      const deals = (results[1] as { stage: string; amount: number }[]).filter((d) => d.stage === 'open')
      const tickets = results[2] as unknown[]
      return say(`${account!.name} has ${deals.length} open deal(s) (${deals.map((d) => `$${d.amount}`).join(', ')}) and ${tickets.length} open ticket(s).`)
    }

    if (/support load/.test(question)) {
      // The runaway: "to be sure nothing changed" it asks for both ticket lists again, every turn.
      if (req.tools.length === 0) {
        const read = results.slice(1) as unknown[][]
        return say(`I read the ticket lists ${read.length} times; the open list has ${read[0]!.length} ticket(s). ` +
          'The tools give no ticket history by month, so I cannot say whether the load went up.')
      }
      return calls(use('list_tickets', { account_id: account!.id, status: 'open' }), use('list_tickets', { account_id: account!.id, status: 'resolved' }, 1))
    }

    // No tool defines a health score. The model guesses anyway, and puts the question after the guess.
    if (/health score/.test(question)) {
      return say(`${account!.name} has a health score of 72 out of 100.\nCLARIFY: No tool defines a health score. Do you mean open tickets, or open deals?`)
    }
    return say('CLARIFY: Which account do you mean?')
  }

  /** Reads a reassignment request into a filter. The agent, not the model, turns it into rows. */
  plan(request: string): Reassign {
    this.calls++
    const m = /Move (.+?)'s (\w+ )?accounts to (.+?)\.?$/.exec(request)
    return { from: m?.[1] ?? '', region: m?.[2]?.trim(), to: m?.[3] ?? '' }
  }

  /**
   * Relays the person's "yes" to the server. The misbehaviour: it "helpfully" sends back every
   * account the old owner has, not the three the person was shown.
   */
  relay<T>(shown: T[], everything: T[]): T[] {
    this.calls++
    return everything.length > shown.length ? everything : shown
  }

  /** Picks the past ticket it thinks matches, asks one question, and writes a reply it was told not to send. */
  triage(_prompt: string, subject: string, matches: { id: number; staff_fix: string }[]): Triage {
    this.calls++
    const top = matches[0]
    if (!top) return { match_id: null, question: 'Which invoice period do you need? And who should receive it?', reply: 'We will send it today.' }
    return {
      match_id: top.id,
      question: 'When did this last work as expected?',
      reply: `Hi, we found the cause and fixed it on our side: we had to ${top.staff_fix}. It is working now.`,
    }
  }
}
