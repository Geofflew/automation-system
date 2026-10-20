# Full demo output

`pnpm generate && pnpm demo` against an empty Postgres database. The model is scripted, the ledger
uses a logical clock and the generator is seeded (`20260302`, anchor 2026-03-02), so this is
byte-identical on every run. The README quotes parts 3 and 4; [mechanisms.md](mechanisms.md)
explains each part.

Where the traps are in the data (`scripts/generate.ts`): messages 6, 7 and 9 carry the
wrong-but-sourced, unsourced and missing-file drafts, and `docs/api-limits.md` says 300; Lee Marsh
owns 10 accounts, 3 of them in EMEA; there are five resolved tickets per problem, so the
stalled-sync ticket has past tickets with its cause.

```
agents-that-know-their-limits. The model is scripted (src/model.ts): no API key, same output every run.

====================================================================================================
1. Product-questions bot: a refusal gate and a post cap
====================================================================================================
BROKEN   the drafter's prompt: "Answer only when you are sure, from the product repo, and name the file. Otherwise say nothing."
         no gate, no cap. 11 of 11 open questions answered in the channel:
         #2  Yes. An admin can export the audit log as CSV from Settings, Audit ...
         #4  It is included. SCIM 2.0 provisioning comes with SAML SSO on the En...
         #5  The slides are in the shared deal folder.   <- no source
         #6  600 requests per minute per workspace. Over that the API returns 429.
         #7  Yes on both. We are SOC 2 Type II certified and we guarantee 99.99%...   <- no source
         #9  Yes. BigQuery is supported as a warehouse connector with hourly sync.
         #10 Yes. An approval rule can require two reviewers, and the period can...
         #11 Yes, retention can be set per customer.
         #12 I’m not certain, but admins can restrict exports to chosen roles.
         #16 Great question! Let me look into that for you. An export file holds...
         #17 An export file holds at most 1,000,000 rows; larger exports are split.

GUARDED  gate + cap of 3 posts per run:
  posted   #2  Yes. An admin can export the audit log as CSV from Settings, ... [docs/audit-log.md]
  posted   #4  It is included. SCIM 2.0 provisioning comes with SAML SSO on ... [docs/sso.md]
  posted   #6  600 requests per minute per workspace. Over that the API retu... [docs/api-limits.md]
  deferred #10 Can approvals require two reviewers before a period is locked? (over the cap; released for the next run)
  refused  #5  Who has the slides from Tuesday's demo?                           no_confidence
  refused  #7  Are we SOC 2 Type II certified, and do we guarantee 99.99% up...  no_source
  refused  #9  Does the warehouse connector support BigQuery?                    source_not_found
  refused  #11 Is data retention configurable per customer?                      low_confidence
  refused  #12 Do we have a way to restrict exports by role?                     hedged
  refused  #16 Can someone confirm the export size limit?                        announces
  refused  #17 Does the retention policy apply to deleted users' data?           off_question
  next run: posted #10; claimed 1 question(s) (refusals stay refused)
  model calls in run 1: 16 (11 drafts + 5 judge calls, only for drafts that passed the free checks)

LIMIT    #6 posted "600 requests per minute per workspace. Over tha..."; its source says "Each workspace may make 300 requests per mi..."
         The gate checks that a source exists, not that it says what the answer says.

DIFF     11 posts -> 3 (+1 next run). The SOC 2 / 99.99% over-claim: posted -> refused no_source.

====================================================================================================
2. Read-only analyst: a tool budget of 6, a forced conclusion, a reply protocol
====================================================================================================
Q: Has "Ember Lantern Group"'s support load gone up?
BROKEN   budget in the prompt only: runaway, 20 tool calls, no answer (demo safety stop at 20)
         calls: find_account, list_tickets, list_tickets, list_tickets, list_tickets, ... the same pair every turn
GUARDED  forced after 6 tool calls. The 7th call in the last turn got a tool_result too: 1 error result
         ("Not run: the tool budget for this question (6 calls) is spent.") in the same message as the other results and the conclude prompt.
         answer: Budget of 6 tool calls spent; answer based on what was read: I read the ticket lists 5 times; the open list has 1 ticket(s). The tools give no ticket history by month, so I cannot say whether the load went up.

Q: What open deals does "Hollow Harbor Co" have, and how many open tickets?
GUARDED  answer after 3 tool calls (find_account, list_deals, list_tickets): Hollow Harbor Co has 1 open deal(s) ($54000) and 2 open ticket(s).

Q: What is the health score for "Ember Meadow Group"?   (no tool defines a health score)
BROKEN   prompt says "never both". The person sees the guess and the question:
           | Ember Meadow Group has a health score of 72 out of 100.
           | CLARIFY: No tool defines a health score. Do you mean open tickets, or open deals?
GUARDED  parser: clarify. Shown: "CLARIFY: No tool defines a health score. Do you mean open tickets, or open deals?"
         dropped, never shown: "Ember Meadow Group has a health score of 72 out of 100."

====================================================================================================
3. Confirm-before-change: the server applies the stored list, never the list in the message
====================================================================================================
Person: "Move Lee Marsh's EMEA accounts to Priya Raman."
Agent proposes 3 changes, turn turn_3b0071b485: Cobalt Harbor Works, Granite Pine Group, Amber Canyon Works. Person: "yes".
The model relays the yes with 10 changes: every account Lee Marsh has.
BROKEN   applied 10. Priya Raman owned 10, now 20: 7 rows nobody was shown.
GUARDED  edited list:          refused: list_mismatch: 10 sent, 3 stored
         turn id + yes:        applied 3. Priya Raman owns 13.
         same yes again:       refused: already_applied
         superseded turn:      refused: stale_turn (the person changed the request)
         row moved meanwhile:  applied 3, refused Copper Ledger Works: row_changed_since_shown
         scheduled run:        refused: not_interactive (proposal of 3 recorded, never applicable)

====================================================================================================
4. Support triage: internal notes only, cause as a check, one note per event
====================================================================================================
BROKEN   client has reply(); prompt: "Triage the ticket. Write an internal note. Do not reply to the customer."
         sent to customer on #501: "Hi, we found the cause and fixed it on our side: we had to rotate the s..."
         sent to customer on #502: "We will send it today."
GUARDED  deliveries A, B, A -> 200, 200, 200; A again after the worker ran -> 200. Events stored: 2, notes written: 2, sent to customer: 0
  note on #501:
    [triage, internal note]
    This is usually an expired connection token on the customer side (3 of the 3 closest past tickets). Check whether Settings, Connections shows the source connection as expired.
    Ask the customer: When did this last work as expected?
    Closest past tickets: #1 (0.23), #5 (0.23), #3 (0.21)
  note on #502:
    [triage, internal note]
    No past ticket is close enough to suggest a cause.
    Ask the customer: Which invoice period do you need?
    Closest past tickets: none
         the model wrote a reply both times; 2 ledger rows say "not sent: client has no reply method".

====================================================================================================
Ledger: every action any agent took, broken runs included
====================================================================================================
agent     action     n  first at           outcome
questions post      11  2026-03-02 09:00  posted (no gate)
questions post       4  2026-03-02 09:11  posted
questions refuse     1  2026-03-02 09:13  no_confidence
questions refuse     1  2026-03-02 09:15  no_source
questions refuse     1  2026-03-02 09:16  source_not_found
questions defer      1  2026-03-02 09:17  over cap of N
questions refuse     1  2026-03-02 09:18  low_confidence
questions refuse     1  2026-03-02 09:19  hedged
questions refuse     1  2026-03-02 09:20  announces
questions refuse     1  2026-03-02 09:21  off_question
analyst   answer     1  2026-03-02 09:23  runaway: stopped at N tool calls
analyst   answer     1  2026-03-02 09:24  forced after N tool call(s)
analyst   answer     1  2026-03-02 09:25  answer after N tool call(s)
analyst   answer     1  2026-03-02 09:26  answer after N tool call(s), no checks
analyst   answer     1  2026-03-02 09:27  clarify after N tool call(s)
changes   propose    4  2026-03-02 09:28  N change(s), pending
changes   apply      1  2026-03-02 09:29  applied N (list from the message)
changes   apply      1  2026-03-02 09:31  refused: list_mismatch: N sent, N stored
changes   apply      2  2026-03-02 09:32  applied N, refused N
changes   apply      1  2026-03-02 09:33  refused: already_applied
changes   apply      1  2026-03-02 09:36  refused: stale_turn
changes   propose    1  2026-03-02 09:38  N change(s), refused_not_interactive
changes   apply      1  2026-03-02 09:39  refused: not_interactive
triage    reply      2  2026-03-02 09:40  sent to customer
triage    add_note   2  2026-03-02 09:42  note on ticket N
triage    reply      2  2026-03-02 09:43  not sent: client has no reply method

last 3 rows for agent changes (id, at, actor, action, inputs_hash, outcome):
  38  2026-03-02 09:37  s-2  apply    a19c483f01ca  applied 3, refused 1
  39  2026-03-02 09:38  s-3  propose  239e2c005d85  3 change(s), refused_not_interactive
  40  2026-03-02 09:39  s-3  apply    c69e8419fac3  refused: not_interactive
total rows: 46
```
