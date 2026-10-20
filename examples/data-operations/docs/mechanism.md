# The mechanisms, on one page

A warehouse that is already live fails differently from one being built. Nothing is wrong with
the SQL in the repo; what is wrong is the gap between the repo and the database, or between two
hosts that read the same setting, or between a schedule and the work it is meant to start. None
of these raise an error. Each mechanism below makes one of those gaps visible.

## 1. Edit after apply

A migration runner records each file it applied by name and skips it next time. That is what
makes it safe to run on every deploy. It also means that editing an applied file does nothing
to any database that already ran it. The edit is reviewed, merged and deployed, and the old view
body keeps running. A test suite cannot see this: tests build a fresh database from the first
migration, so they always run the edited file and pass.

The guard compares the live database with what the repo would produce. Apply every migration
into a scratch schema, read each view's `pg_get_viewdef` and each function's body from both,
compare them exactly (Postgres prints both sides, so only an edit differs), and list every
relation that differs. That diff is the only evidence: the
migrations table says the file ran, not what it said when it ran. A cheap pre-check flags any
migration file with more than one commit in git history as suspect. The fix for real drift is a
new migration that re-issues the definition, never another edit.

## 2. NULL stubs

When a view is ported while a source column is missing, the quick fix is `NULL::text AS col`.
When the column comes back, the stub stays. The view returns NULL in every row, the screen hides
a filter with no values, and a feature disappears with no error anywhere. The guard reads every
view definition for `NULL::<type> AS <name>` and reports the ones where a base table the view
reads now has a column called `<name>`.

## 3. Lost defaults

A schema created by a copy tool, then "completed" by a baseline that uses
`ADD COLUMN IF NOT EXISTS`, keeps whatever the copy tool made for columns that already existed:
no `NOT NULL`, no `DEFAULT`. A revision counter that should start at 0 starts NULL; `NULL + 1`
is NULL; every compare-and-set write (`WHERE revision = $seen`) matches nothing and is logged as
a lost race. The guard builds the baseline into an empty scratch schema, where every
`CREATE TABLE` runs in full, diffs `information_schema.columns` against live, and prints the
statements that close the gap, backfill first.

## 4. Lock queue

Redefining a view takes an exclusive lock. If a long reader holds the view, the migration
waits, and every reader that arrives after the migration queues behind it, because Postgres
grants locks in order. One stuck reader plus one migration stops every read of that view. The
guard runs each migration in `BEGIN; SET LOCAL lock_timeout = ...`, so a migration that cannot
get its lock gives up within seconds, rolls back, and retries with backoff. Readers wait at most
one timeout. After the last attempt the deploy fails, which is better than a queue.

## 5. Event landing

A public endpoint that does the work inline is slow, and a slow endpoint makes the sender time
out and retry, so the work happens two or three times. The guard splits it: the receiver
verifies the signature, inserts the raw event with a role that can only insert, and returns 200.
A private worker claims unhandled events, runs the handler, and marks them handled; the handler
is idempotent on the event id, so a duplicate delivery or a replay writes nothing new. An insert
trigger calls `pg_notify`, so a listening worker drains at once; a periodic sweep is the backstop
for anything missed while it reconnects. A dry run processes one event inside a transaction that
is rolled back.

## 6. One schedule, many jobs

A host that allows one schedule per service needs a dispatcher: one tick a minute, a jobs table
with a schedule each, and a kill-switch list read on every tick. The trap is a switch that means
two things. On one host a route read its switch to skip an optional half of its work; on the
next host the dispatcher read the same switch to skip the whole route, and the required half
went silent. The guard gives the optional half its own job name, so every switch means "do not
run this job", and the dispatcher prints the last run of every job so a job with no runs shows.

## 7. Reconciliation

A ledger rebuilt from events and a finance workbook disagree for two kinds of reason: rules
(the workbook counts a win-back as new; it folds one product line into expansion) and data
(rows one side has and the other does not). The harness applies the rules one at a time and
compares deal by deal, then traces whatever residual is left to the rows that cause it. A total
that matches is not enough; a residual nobody can name is a bug waiting.
