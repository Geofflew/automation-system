# Mechanism notes

One idea, four times: a limit an agent must respect is enforced by the code around the model, in a
place the model's output cannot reach, and never only by a sentence in the prompt.

1. **Refusal gate and post cap.** A drafter proposes an answer with a confidence and a source. The
   app posts only what it can check without trusting the drafter: a confidence above a bar, a source
   path that resolves to a real file inside the product repo, no hedging, no announcing, and one
   cheap model call that says the answer addresses the question. At most three posts a run; the
   overflow is released for the next run. The gate cannot catch a confident, sourced, wrong answer.
   The source requirement is what makes that case recoverable: a reader can open the file.

2. **Tool budget and reply protocol.** The loop counts tool calls, not the model. When the count
   reaches the budget, every pending tool call still gets a result (an error saying the budget is
   spent), in the same message, followed by an instruction to conclude, and the next call has no
   tools. A reply is either a clarifying question on its first line or an answer; if both appear,
   the question wins and the guess is dropped before anyone sees it.

3. **Confirm-before-change.** A proposal is stored server-side under a turn id. A confirmation
   carries the turn id; the server applies its own stored list. A confirmation with a different list,
   an old turn, a turn already applied, or an unattended session is refused. Each row is applied only
   if it still holds the value the person was shown. The claim on the proposal is one
   compare-and-set statement, so two racing confirmations apply once.

4. **Notes-only triage.** The webhook receiver stores the raw event under its event id and returns
   200; a redelivery is a no-op. The worker builds its own client, which has one method, addNote,
   so a reply is not refused; it is not expressible. The note's cause line is composed by code
   from the past ticket the model picked: the customer-side cause as "usually", a check the customer
   can do, never the staff-side fix, and exactly one question.

Every action, broken or guarded, writes a ledger row: when, which agent, who, what, a hash of the
inputs, and the outcome.
