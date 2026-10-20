# Mechanisms, in full

The README gives one paragraph per mechanism. This file has the full treatment: what the code
does, the design choice, what was rejected, and the demo section that shows it. Ordered as in the
README: the two authority mechanisms first, then the tool budget, then the refusal gate. The full
demo output is in [demo-output.md](demo-output.md).

## The model is scripted

`src/model.ts:ScriptedModel` stands in for every model call: the drafter, the relevance judge, the
analyst, the request reader, the confirmation relay and the triage call. Each is a lookup written
to misbehave in exactly the way its guard exists to catch: a 0.97-confidence answer with no source,
a loop that asks for the same two tool calls every turn, a guess on the line above a `CLARIFY:`, a
relay that sends back every account instead of the three shown, a reply after a prompt said not to
reply. The prompts are passed in and ignored, which is the point: the demo shows what happens when
the prompt is not obeyed. The guards never read the scripts; they see only what a real call would
return. That makes the demo deterministic and keyless, and it means the demo proves the guards,
not that a real model makes these mistakes. They are the failure shapes these guards were built
against; the demo cannot show how often a real model produces them. No live model is wired in.

The scripted analyst also enforces the API's rule that every `tool_use` is answered by a
`tool_result` in the very next message (`checkTranscript`), so a loop that breaks the rule fails
here the way it fails against the real API.

## 1. Confirm-before-change (part 3 of the demo)

`src/changes.ts:propose` turns the request into a filter (the model's only job here), reads the
matching rows itself, and stores the list under a turn_id in `proposals`. `confirm` takes a message
with the turn_id and the person's yes, and refuses in this order: an unknown turn, an unattended
session (`interactive: false` on the proposal or the message), no yes, a list in the message that
differs from the stored one (`list_mismatch`), then, under the session lock, a turn that is not the
session's latest (`stale_turn`) and a turn already applied. Then it applies the stored list, each
row only if its owner is still the one the person saw.

Three choices worth stopping on.

**The stored list is the thing applied.** The list in the confirmation message is compared, never
applied. An edited list is refused, not silently replaced by the stored one: a confirmation that
disagrees with what was shown means something upstream is wrong, and the person should hear about
it. Rejected: applying the list the message carries (the broken path), which lets a relay that
rewrote the list change rows nobody was shown.

**The latest-turn check and the claim are serialised per session.** A first version read the
session's `max(seq)`, then claimed the proposal with a compare-and-set. A newer proposal committed
between the read and the claim went unseen, and the superseded list applied; an external review
reproduced it moving three accounts after the request had changed. Now `propose` and `confirm` both
take `pg_advisory_xact_lock(hashtext(session_id))` inside their transaction, and `confirm` reads the
latest turn only once it holds the lock. A newer proposal either committed before the lock was
taken, and the check sees it (`stale_turn`), or it waits until the confirmation commits, in which
case the yes really did come first and the newer proposal is written after it. `confirm` has a test
seam with two points, `'read'` (after the proposal is read, before the lock) and `'locked'` (after
the check, before the claim), and one test forces each order:

- a newer proposal committed at `'read'` makes the old turn `stale_turn`; on the version without the
  lock the old list applied (the test fails there);
- a proposal started at `'locked'` is queued on the lock until the confirmation commits; with the
  lock removed from `confirm` it commits inside the window and the test fails;
- two proposals at once in one session get seq 1 and 2; without the lock in `propose` both read the
  same count and one fails on the primary key.

The key is the session id, so a confirmation in session A does not wait on session B (tested by
holding B's lock while A confirms). Rejected: `SERIALIZABLE` isolation, which would also catch the
interleaving but surfaces it as a serialization failure every caller must retry; and `SELECT ...
FOR UPDATE` on the session's latest proposal, which cannot lock a row that has not been inserted yet.

**The claim is one compare-and-set statement**, `UPDATE proposals SET status = 'applied' WHERE
turn_id = $1 AND status = 'pending'`, inside the apply transaction. Two confirmations of the same
turn are forced to race by a barrier at the `'read'` seam point: both read the proposal as pending,
then both proceed; the second now waits on the session lock, then finds the proposal no longer
pending, and is `already_applied`. Rejected: reading the status, then writing it, which on the
version without the lock let both through.

```
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
```

Notice "row moved meanwhile": someone else reassigned one of the four proposed accounts between
the proposal and the yes, so that one is refused and the other three apply. The demo runs the
calls one after another; the concurrent cases are in `test/agents.test.ts`.

## 2. Notes-only triage (part 4)

`src/triage.ts:receive` parses only the event id, stores the raw body with `ON CONFLICT (event_id)
DO NOTHING`, and returns 200. `work` takes events with `FOR UPDATE SKIP LOCKED`, builds its own
client with `notesClient`, and writes one note per event. `notesClient` returns an object whose only
key is `addNote` (tested), and its type has no `reply`, so `client.reply(...)` is a compile error
(a `@ts-expect-error` test; `pnpm test` runs `tsc` first, so the test fails if `reply` ever
exists). The worker is not handed a client, so no caller can pass it a wider one. The model's
reply text is recorded in the ledger as "not sent".

`similar` is word overlap (Jaccard over lowercased words, stopwords removed) against the resolved
tickets; the top three at 0.2 or above. The model picks one; `composeNote` writes the cause line
from that corpus row's `cause` and `customer_check` columns, so it always reads "This is usually X.
Check Y.", never a verdict and never the `staff_fix` column. A pick outside the retrieved set is
ignored. `oneQuestion` keeps the first question only.

The example suggests a customer-side check from a similar synthetic ticket, giving the person
handling it something to investigate without claiming the cause is established. Rejected: a verdict ("the cause is X"), which a past ticket
cannot support; a prompt that forbids replying (the broken path); and an embeddings index, which
this corpus does not need.

```
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
```

Notice the broken reply: a verdict ("we found the cause") and a staff-side fix, sent to a customer.
The guarded note says "usually", gives a check the customer can do, and asks one question; the
model asked two on #502 and only the first was kept.

## 3. Tool budget, forced conclusion, reply protocol (part 2)

`src/analyst.ts:ask` counts tool calls itself. When the count reaches `TOOL_BUDGET` (6), every
`tool_use` in that turn still gets a `tool_result`: the ones over budget get an error result, and all
of them go in one user message with a text block telling the model the budget is spent. The next
call is made with no tools. If the model still asks for one, the question ends `refused`. The
loop prefixes the forced answer with `FORCED_PREFIX` ("Budget of 6 tool calls spent; answer based
on what was read:"), so a conclusion from partial reads is marked as such whatever the model wrote
(tested with a question that needs 8 calls).

The non-obvious part is the forced conclusion. Stopping the loop when the cap trips throws away
six reads and returns nothing, which is the expensive failure. Sending the conclude prompt as a new
message after an unanswered `tool_use` is an invalid request: that is the API's rule. So the
over-budget calls are answered as errors, and the model concludes from what it has. All of a turn's
results go in one message; that part is this repo's own rule, stricter than the API, which merges
consecutive user messages. The loop refuses a split because results sent one per message train the
model to stop making parallel calls (`checkTranscript`, and the test that refuses a split).
Rejected: a budget in the prompt, which the broken run shows being ignored, and a cap on model
calls instead of tool calls, which lets one turn ask for many tools at once.

`parseReply` enforces the protocol: if any line starts `CLARIFY:`, the reply is a clarifying
question and every other line is dropped. A guess shown next to a question is still a guess the
person will repeat. The tool descriptions in `TOOLS` are the field dictionary; "health score" is
in none of them.

```
Q: Has "Ember Lantern Group"'s support load gone up?
BROKEN   budget in the prompt only: runaway, 20 tool calls, no answer (demo safety stop at 20)
         calls: find_account, list_tickets, list_tickets, list_tickets, list_tickets, ... the same pair every turn
GUARDED  forced after 6 tool calls. The 7th call in the last turn got a tool_result too: 1 error result
         ("Not run: the tool budget for this question (6 calls) is spent.") in the same message as the other results and the conclude prompt.
         answer: Budget of 6 tool calls spent; answer based on what was read: I read the ticket lists 5 times; the open list
         has 1 ticket(s). The tools give no ticket history by month, so I cannot say whether the load went up.

Q: What open deals does "Hollow Harbor Co" have, and how many open tickets?
GUARDED  answer after 3 tool calls (find_account, list_deals, list_tickets): Hollow Harbor Co has 1 open deal(s) ($54000) and 2 open ticket(s).

Q: What is the health score for "Ember Meadow Group"?   (no tool defines a health score)
BROKEN   prompt says "never both". The person sees the guess and the question:
           | Ember Meadow Group has a health score of 72 out of 100.
           | CLARIFY: No tool defines a health score. Do you mean open tickets, or open deals?
GUARDED  parser: clarify. Shown: "CLARIFY: No tool defines a health score. Do you mean open tickets, or open deals?"
         dropped, never shown: "Ember Meadow Group has a health score of 72 out of 100."
```

Notice that the budget trips in the middle of a turn that asked for two calls: one runs, the other
is still answered (with an error result) in the same message, and the conclusion comes from what
was read, prefixed by code with the budget state so the person knows it may be partial. The normal
question finishes in 3 calls, so the budget does not get in its way.

## 4. Refusal gate and post cap (part 1)

`src/questions.ts:gate` runs the free checks first (`cheapChecks`): an answer, a numeric confidence
of at least 0.8, a source, a source that resolves to a file inside the product repo
(`sourceExists`, which also refuses `../../package.json`, a file that exists and is not a source),
no hedge phrase, no announcement phrase. Only a draft that survives all of them costs the one model
call, `judge`, which says whether the answer addresses the question. A judge outage is its own
reason, `judge_unavailable`, and releases the claim so a later run retries, rather than writing
the question off.

`runGuarded` posts at most `MAX_POSTS_PER_RUN` (3) and releases the rest. A claim is a row in
`question_claims` with the message as its primary key, so two runs cannot draft the same question
and a refused question is not drafted again every run.

The design choice is that refusal is the default. The two errors differ in size: a wrong answer
is passed on to a prospect as fact, while an unanswered question waits for a person, which is how
the channel worked before the bot. Rejected: asking the drafter to be careful (the broken run), and
a second model to grade every answer, which costs a call per draft and is still a model agreeing.
The phrase lists are blunt on purpose: free, run on every draft, and when they over-fire the ledger
says which rule did it. They are matched after `normalise`, because models write U+2019 and the
patterns are ASCII; without it, `I’m not certain` passes (tested).

The cap bounds posts, not model calls: every claimed question is still drafted and gated, so the
demo's refusals all show in one run.

```
BROKEN   the drafter's prompt: "Answer only when you are sure, from the product repo, and name the file. Otherwise say nothing."
         no gate, no cap. 11 of 11 open questions answered in the channel:
         #7  Yes on both. We are SOC 2 Type II certified and we guarantee 99.99%...   <- no source
         ...
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
DIFF     11 posts -> 3 (+1 next run). The SOC 2 / 99.99% over-claim: posted -> refused no_source.
```

The channel has 26 messages; 11 contain a question nobody answered (a twelfth already has a
person's reply and is skipped). Notice that each refusal names one rule, that the fourth good answer
is deferred and posts on the next run rather than vanishing, and the LIMIT line: a confident answer
citing a real file that says something else is posted. #12's hedge is written with a typographic
apostrophe (`I’m not certain`), which the hedge list only catches because answers are normalised
first.

## The ledger

`src/db.ts:record` writes when, agent, actor, action, a 12-character SHA-256 of the inputs, and the
outcome, for every post, refusal, deferral, answer, proposal, apply, note and reply attempt, broken
runs included. It lives in schema `audit`, so rebuilding the data between demo parts keeps it. The
timestamps come from a logical clock (one minute per row from the anchor) so the printout is stable.
The demo's last part prints it grouped by agent, action and outcome (26 groups, 46 rows); see
[demo-output.md](demo-output.md).
