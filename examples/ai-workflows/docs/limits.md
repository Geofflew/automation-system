# Scope and implementation limits

[Back to the overview](../README.md)


- The model is scripted. The demo proves what the guards do with bad output; it does not prove a
  real model produces that output, or how often.
- The confirm agent trusts the session id it is given. There is no authentication here; in a real
  server the session and the person's identity come from the authenticated request.
- A proposal does not expire; only a newer proposal in the same session makes it stale.
- The session lock is `hashtext(session_id)`, a 32-bit hash. Two sessions whose ids collide share a
  lock: they wait on each other needlessly, never wrongly. It is also per database; proposals and
  confirmations for one session must go to the same one.
- The note's idempotency relies on the support tool accepting a key (here, a unique `event_id`
  column). A tool that does not take one can get a duplicate note if the worker crashes between
  writing the note and marking the event done. The same ticket redelivered under a new event id
  writes a second note.
- Word overlap finds tickets that use the same words. A customer who describes the same problem in
  other words gets no cause line; one who uses the same words for a different problem gets the
  wrong one, phrased as "usually".
- The budget counts tool calls, not tokens or time. A question that needs more than 6 calls gets a
  forced answer from partial reads (a total over 2 of 4 accounts, say), marked with the budget
  prefix, not completed. The read-only guarantee is the tool code (`BEGIN READ ONLY`, fixed SQL),
  not a database role.
- A model that guesses a field with no `CLARIFY:` line ("health score is 72") is not caught: nothing
  checks the answer's numbers against the tool results.
- The gate cannot reject a confident, sourced, wrong answer (the LIMIT line). The hedge and
  announcement lists are phrase lists: an unlisted hedge passes, and a legitimate answer containing
  "probably" is refused. The judge is one model call; a judge wrong about relevance is not caught.
