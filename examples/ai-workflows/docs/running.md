# Run the example

[Back to the overview](../README.md)


Use Node 22+, pnpm 11, Git, and a dedicated disposable PostgreSQL database. Create the database
first; generators and tests rebuild example schemas. Do not point them at an application database.

```sh
export DATABASE_URL=postgres://user@127.0.0.1:5432/acme_agents   # any Postgres 14+, an empty database
pnpm i && pnpm generate && pnpm demo
pnpm test                                                         # tsc, then 26 tests; rebuilds the data
```

No API key: the model is scripted, so the output is identical on every run. Four parts, each BROKEN
then GUARDED, then the ledger. The two the five-minute read refers to (the full output is in
[docs/demo-output.md](demo-output.md)):

**Part 3, confirm-before-change.** Owner "Lee Marsh" has 10 accounts, 3 in EMEA.

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

Notice that each refusal is a different rule, that "row moved meanwhile" applies three of four
because someone moved the fourth after it was shown, and that a scheduled run can propose but never
apply. The concurrent cases (a newer proposal mid-confirmation, two racing confirmations) are
forced in the tests.

**Part 4, support triage.** A stalled sync (five past tickets share its cause) and an invoice
request (no past ticket is close).

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
  ...
         the model wrote a reply both times; 2 ledger rows say "not sent: client has no reply method".
```

Notice that the model still wrote a reply both times; it went nowhere. The note's cause line is
built from columns of the past ticket ("usually" plus a customer-side check), so a staff-side fix
cannot leak into it.
