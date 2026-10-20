# The seven mechanisms in full

One section per mechanism: what the demo prints for it and what to notice, then how it works, the design choice and the rejected alternative. The README carries the lock-queue runner in full and one paragraph for each of the others. The whole demo output, unedited, is in [demo-output.md](demo-output.md).

Terms used below. A **migration runner** applies numbered SQL files and records each one by name
so it never runs twice. **Drift** is a view or function whose live definition differs from what
the repo's migrations produce. A **NULL stub** is `NULL::<type> AS <col>` in a view, written while
`<col>` did not exist. The **baseline** is the re-runnable schema file the app's tables are meant
to match. A **compare-and-set** write updates a row only if its revision is still the one read.
The **kill switch** is the list of job names the dispatcher must not run. The **residual** is what
is left of a reconciliation once every known rule is applied.

Where the traps are in the data (`scripts/generate.ts`, anchor 2026-07-01, fixed seed): migration
002's `<> 'lost'` and 12 won deals among 60; `support.tickets` gets `product_type` after the view
and a deliberate `sentiment` stub with no source; `app_live` tables made with no defaults, 30
copied rows with revisions and 8 new rows without; five events at fixed offsets in the minute;
deals D-0023, D-0046, D-0069, D-0092, D-0115 and D-0138 with no company, in the last two quarters.

## 1. Edit-after-apply detector

Production ran migrations 001-003. View `open_deals` (002) counts won deals as open.

```
a reviewer edits 002 in place: WHERE d.stage NOT IN ('won', 'lost'); reviewed, merged, deployed.
BROKEN   deploy: applied 0, skipped 3 (001-deals.sql, 002-open-deals.sql, 003-deal-size.sql): recorded by name, never re-run
         test suite (fresh schema built from 001): open_deals has 0 won deals -> PASS
         production: open_deals still has 12 won deals. Green suite, wrong production.
GUARDED  pre-check, git log per file: 002-open-deals.sql has 2 commits -> suspect
         drift (repo built into a scratch schema, pg_get_viewdef and function bodies compared): 1 relation differs
           view open_deals differs
             live: ... d.stage <> 'lost'::text;...
             repo: ... d.stage <> ALL (ARRAY['won'::text, 'lost'::te...
         the fix is a new file: applied 004-open-deals-excludes-won.sql. production won deals: 0; drift now: 0 differ
```

Notice that the test and production disagree and both are "right" about the file they ran. The
drift lines are Postgres's own rendering of each body, not the file's text.

### How it works

`src/drift.ts:drift` drops and rebuilds a scratch schema from the repo's migrations with the same
runner (`src/migrate.ts:migrate`). It then reads every view (`pg_get_viewdef(oid, true)`) and every
function (result type plus `prosrc`) from both schemas, trims the ends and compares the text exactly.
It reports `differs`, `missing_live` or `extra_live`. Each schema's definitions are printed with
`search_path` set to that schema alone, so Postgres leaves names unqualified and two schemas that
agree print the same text. The migrations use unqualified names on purpose. The runner sets
`search_path`, so the same files build live, a test schema or the scratch schema.
Nothing inside the text is rewritten. An earlier version collapsed runs of whitespace before
comparing, which also rewrote string literals, so a function returning `'a b'` and one returning
`'a  b'` compared equal. Both sides come from Postgres's own printer, so no rewrite is needed:
when the objects agree, the text agrees byte for byte (tested, including the literal case).
`src/drift.ts:suspects` is the cheap pre-check: `git log --oneline -- <file>` with more than one
commit.

The design choice is to compare objects, not files. The other option is a checksum of each file
recorded at apply time. It is cheaper, and it catches an edit to any file applied after you
added it. But it cannot see edits made before checksums existed, and it flags a corrected comment
as loudly as a changed view body. The object diff is the only evidence of what production
actually runs. The fix for drift is a new migration that re-issues the definition (part 1 ends
with one), never another edit to the old file.

## 2. NULL-stub finder

`support.ticket_facts` was written with `NULL::text AS product_type` before
`tickets.product_type` existed. The column was added and filled later.

```
BROKEN   the screen shows filters: status, priority   (product_type hidden: every value is NULL, no error anywhere)
GUARDED  finding: ticket_facts.product_type is NULL::text, but support.tickets.product_type exists (240 of 240 rows filled)
         not reported: ticket_facts.sentiment is also NULL::text, and no table it reads has a sentiment column
         after re-issuing the view: filters status, priority, product_type; findings now 0
```

### How it works

`src/stubs.ts:findStubs` matches `NULL::<type> AS <name>` in each view's printed definition, including
multi-word types (`timestamp with time zone`) and types with modifiers (`character varying(40)`,
`numeric(12,2)`), both tested. It looks up the relations
the view reads in `pg_depend` through the view's rewrite rule, not by parsing SQL, and reports
the stub only if one of them now has a column `<name>`. The source is read as `oid::regclass`,
which prints it schema-qualified and quoted where needed, and the row count reads that name, so a
semantic view over a table in a raw schema works (tested); `Stub.source` carries the qualified name. Each finding counts how many source rows
have a value: that is how much the screen is hiding. A stub with no source column is left alone,
because it may be deliberate (`sentiment` in the demo).

## 3. Lost-defaults diff

A copy tool made `app_live`'s tables, then the baseline ran.

```
8 work orders written since have revision NULL.
BROKEN   order 31: the bump trigger ran, revision is null (NULL + 1); 5 compare-and-set writes, 0 succeeded, 5 missed (each caller sees "changed under me")
         order 5 (copied with revision 1): compare-and-set succeeded
GUARDED  baseline built into a scratch schema, information_schema.columns compared: 5 gaps
           usage_events.batch: no_default (baseline: NOT NULL, default 'single'::text)
           usage_events.kind: nullable (baseline: NOT NULL, default none)
           work_orders.phase: no_default (baseline: NOT NULL, default 'open'::text)
           work_orders.revision: no_default (baseline: NOT NULL, default 0)
           work_orders.title: nullable (baseline: NOT NULL, default none)
         11 statements, backfill first, the bump trigger disabled around it (it would recompute NULL + 1):
           ALTER TABLE app_live.work_orders DISABLE TRIGGER USER; UPDATE app_live.work_orders SET revision = 0 WHERE revision IS NULL; ALTER TABLE app_live.work_orders ENABLE TRIGGER USER;
           ALTER TABLE app_live.work_orders ALTER COLUMN revision SET DEFAULT 0;
           ALTER TABLE app_live.work_orders ALTER COLUMN revision SET NOT NULL;
           ... (8 more for the other gaps)
         after: order 31 compare-and-set succeeded; gaps now 0
```

Notice that old rows work and new rows do not. That is what this failure looks like in a log: a
race lost on some records only. Notice too the trigger line. The obvious backfill,
`UPDATE ... SET revision = 0`, fires the bump trigger. The trigger sets the new revision to the
old one plus 1, which is NULL, so the backfill undoes itself (tested).

### How it works

`src/defaults.ts:defaultsDiff` runs `baseline/schema.sql` into an empty scratch schema, where each
`CREATE TABLE` runs in full. It then compares `information_schema.columns` (nullability and
default) with live, after removing each schema's own name from the defaults.
`src/defaults.ts:fixStatements` prints, per gap, the backfill, then `SET DEFAULT`, then
`SET NOT NULL`. Backfill comes first because `SET NOT NULL` fails on a NULL row. On a table with
its own triggers, the backfill runs between `DISABLE TRIGGER USER` and `ENABLE TRIGGER USER`.

The non-obvious part is that trigger. The column whose default was lost is the one a
bump-on-update trigger maintains, and the backfill is an update, so the trigger rewrites the new
value from the old NULL. Rejected: making the trigger `coalesce(OLD.revision, 0) + 1`. It repairs
this one column and hides the next lost default. A missing column is printed as a comment, not
generated, because a skipped `ADD COLUMN` is worth a person's look.

## 4. Lock-timeout migration runner

`m4-long-reader` holds an open transaction that has read `open_deals`.
Migration 004 redefines `open_deals`. Every connection has a hard timeout, so the broken half ends.

```
BROKEN   no lock_timeout. pg_stat_activity, wait_event_type = 'Lock': m4-migration, m4-reader-3
         m4-reader-3 is a plain SELECT. It waits behind the migration, not behind the long reader.
         m4-reader-3: cancelled by its 1.5 s statement_timeout (57014), never granted its lock; without a cap it waits as long as the long reader lives
         migration: cancelled by the demo cap, 3 s statement_timeout (57014)
GUARDED  BEGIN; SET LOCAL lock_timeout = '500ms'; up to 4 attempts, backoff 250 ms doubling
         attempt 1: canceling statement due to lock timeout. held by: m4-long-reader (idle in transaction: SELECT count(*) FROM ops_busy.open_deals); queued behind it: m4-reader-3 (active: SELECT count(*) FROM ops_busy.open_deals)
         attempt 2: canceling statement due to lock timeout. held by: m4-long-reader (idle in transaction: SELECT count(*) FROM ops_busy.open_deals); queued behind it: none
         (the long reader finishes)
         attempt 3: applied 004-open-deals-excludes-won.sql
         m4-reader-3 answered in under 1 s: it waited for at most one lock_timeout, then went ahead of the retry
         if the reader never ends: 55P03 canceling statement due to lock timeout after 3 attempts, under 5 s; each attempt held the queue for at most its 500 ms, and the deploy fails
```

Notice that the long reader does not block reader 3; their locks are compatible. The migration
blocks it. The wait times are real and vary between runs. The demo prints only bounds ("under
1 s"), so the output does not change.

### How it works

`src/migrate.ts:withLockTimeout` runs each file in `BEGIN; SET LOCAL lock_timeout = <ms>`. On
error `55P03` it rolls back the whole transaction, waits (backoff doubling) and tries again. After
the last attempt it throws, and the deploy fails. Given a second connection (`monitor`), each
attempt samples `pg_blocking_pids` every 50 ms: who holds the lock it wants, and who is waiting on
it. Those are the readers it would have held up.

Why `lock_timeout` and not `statement_timeout`: a statement timeout also cancels a migration that
is slow for honest reasons, such as a large backfill. It also does nothing about the queue until
it fires. The queue forms because Postgres grants locks in arrival order. A reader arriving after
the waiting migration waits behind it, even though the reader's lock is compatible with the long
reader's. `lock_timeout` bounds only that wait. `SET LOCAL` keeps the setting inside the
migration's transaction.

## 5. Event landing

Five webhook events about generated accounts.

```
BROKEN   receiver does the work inline (300 ms); the sender waits 100 ms, then retries, 3 attempts.
         evt_1001: 3 deliveries, the work ran 3 times
GUARDED  store-then-ack: evt_1001 answered on attempt 1; a redelivery -> 200; a bad signature -> 401; rows stored: 1
         stored by role acme_ops_landing_writer; that role reading the table: permission denied for table events
         4 more events. Sweep-only, every 60 s (computed from where each lands in the minute): handled 23500, 27500, 38500, 52500 ms after landing; worst case 60000
         notify on insert (measured): every event handled under 250 ms after it was stored
         replay (handled = false on all 5, drained again): effects 5 -> 5
         dry run of evt_2001: would write 1 effect (reply for Quiet Meadow Co); effects still 5, event still unhandled: true
```

Notice the two latency lines are measured differently. Nobody waits a real minute in a demo, so
the sweep figure is computed from each event's offset in the minute. The notify figure is
measured on the wall clock and printed as a bound.

### How it works

`src/landing.ts:receive` verifies an HMAC signature, parses only the event id, and inserts the
raw body under `SET ROLE acme_ops_landing_writer`. That role has `INSERT` on one table and nothing
else. A `stored_by DEFAULT current_user` column proves which role wrote the row (tested). The
insert is written in the one form that role may run: a bare `ON CONFLICT DO NOTHING`, because
naming the conflict target `(event_id)` needs `SELECT` on that column, and no `RETURNING`, which
also needs `SELECT`. An insert trigger calls `pg_notify`. `src/landing.ts:listen` holds one
connection on `LISTEN` and drains at once. A notification that arrives during a drain asks for
one more pass. `src/landing.ts:drain` claims one event at a time with `FOR UPDATE SKIP LOCKED`,
so the notify drain and a sweep can overlap, then runs the handler and sets `handled` in the same
transaction. The handler writes one effect per event id (primary key), so a replay
(`handled = false`) writes nothing new. `src/landing.ts:dryRun` runs the handler inside a
transaction it always rolls back.

Rejected: deleting handled events, which makes replay impossible, and a sweep alone, which makes
every event wait for the next minute. The sweep stays as the backstop for whatever arrives while
the listener reconnects. No HTTP server: the receiver is a function that returns a status code,
and `send` plays a sender that retries after a timeout.

## 6. One-schedule dispatcher

Someone switches off `crm-sync` on the jobs screen. Its label says
"duplicate detection (does not stop the sync)".

```
BROKEN   old host (calls every route on its schedule; the route reads the switch): 14 days, sync 14 runs, dedupe 0
         new host (one schedule; dispatcher ticks every 30 min, skips switched-off names): 14 days, sync 0 runs, dedupe 0
           crm-sync        runs  0  last -                 WARN no runs logged since 2026-06-15 (switched off)
           nightly-rollup  runs 14  last 2026-06-28 02:30
GUARDED  duplicate detection is its own job, crm-dedupe, and that is the name switched off. 14 days: sync 14 runs, dedupe 0
           crm-dedupe      runs  0  last -                 WARN no runs logged since 2026-06-15 (switched off)
           crm-sync        runs 14  last 2026-06-28 06:00
           nightly-rollup  runs 14  last 2026-06-28 02:30
         the switch row missing at a tick where crm-sync is due: ran 0; no disabled_jobs row; running nothing until one exists
```

Notice that the same switch, set the same way, gives 14 syncs on one host and none on the other.

### How it works

`src/dispatch.ts:tick` reads every job's last start and the kill switch in one query. It runs
each job whose schedule fired since that job last started and whose name is not switched off,
and logs a run row for each. Two decisions are worth stopping on. "Fired since last start"
(`firedSince`) rather than "matches this minute" means a late tick still starts the job once
(tested). The other option drops the run silently. And a missing or unreadable switch row runs
nothing. Treating "could not read the list" as "nothing is switched off" would start every job
someone stopped. `src/dispatch.ts:lastRuns` prints each job's runs and last start over a window,
and warns when a job's schedule fired with no run logged. `parseSchedule` reads three fields
(minute, hour, weekday) and throws on anything else, so a typo fails at registration.

The lesson is about names, not code: a switch must mean one thing. The broken route used its own
switch to skip an optional half. That is harmless on a host that always calls the route, and
fatal on one where the dispatcher reads the same switch. The guard makes the optional half its
own job name, so every switch means "do not run this job".

## 7. Reconciliation harness

A ledger rebuilt from deal events against a finance workbook, over 12 quarters.

```
ledger rebuilt from 180 deal events; finance workbook has 180 rows. New and expansion, per quarter:
  no rules                                                               1 of 12 quarters match exactly
  the services line folded into expansion                                4 of 12 quarters match exactly
  the services line folded into expansion + win-backs counted as new     10 of 12 quarters match exactly
BROKEN   with no rules, the two disagree in 11 quarters and nothing says why.
GUARDED  both rules, deal by deal: 174 of 180 workbook rows match a ledger row exactly.
           2026-Q1: new 33850 vs 41900, expansion 4800 vs 10400
           2026-Q2: new 14650 vs 23750, expansion 1750 vs 1750
           D-0023 2026-01-12 new       workbook 2900, ledger -: deal has no company link; the ledger reads deals through companies
           ...  (6 rows, all the same cause)
         10 of 12 quarters match exactly; residual 22750 traced to 6 rows
```

### How it works

The ledger is a view over deal events, joined through deals to companies the way reports group
them. It keeps win-backs and the services line as separate categories. `src/reconcile.ts:RULES`
names the workbook's two rules as category mappings. `reconcile` applies them one at a time and
prints how many quarters match after each. `residual` full-joins the ledger to the workbook per
deal, per day and per category, and gives each difference a cause read from the source rows:
no company link, a company that does not exist, not in the event stream, amounts differ (tested),
or present on one side only.

The design choice is that the rules live in the harness, named, and never in the ledger. The
ledger stays true to the events. The rules record a decision someone made about presentation,
and each one shows up in the printout as the step that closed a gap. Rejected: matching only on
totals. Two errors that cancel pass a totals check, and a residual with no rows behind it cannot
be fixed.
