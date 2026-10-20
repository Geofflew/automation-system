# Scope and implementation limits

[Back to the overview](../README.md)


- Drift compares views, materialised views and function bodies, not tables, indexes, grants or
  triggers. For a function it compares the result type and the body only, not volatility,
  `STRICT`, `SECURITY DEFINER` or `SET` clauses. Table shape is part 3's job. Postgres stores a
  function body as written, so re-indenting or re-commenting an applied function file also shows
  as drift; a view is re-printed by Postgres, so its formatting never does. It needs migrations that build into any schema, so a
  migration that names its schema does not work with it. It cannot tell you which file was
  edited; the git pre-check only suggests one.
- The stub finder knows only the `NULL::type AS name` shape. A stub written as `''::text`, `0`, or
  a `CASE` that always returns NULL is not found. It checks the relations a view reads directly,
  in any schema, not tables behind another view.
- The defaults diff compares nullability and defaults only, not types or constraints: a CHECK,
  UNIQUE or foreign key lost the same way is not reported, and "gaps now 0" says nothing about
  them. It cannot make an
  expression default safe to backfill: a `now()` default backfills every old row with today.
  `DISABLE TRIGGER USER` takes a strong lock on the table and turns off every user trigger, not
  only the one that bumps the revision.
- `lock_timeout` bounds the wait for a lock, not a slow statement. `lock_timeout` applies to each
  lock separately, so readers of the first object a migration locks can wait up to one timeout
  per later lock it takes, in each attempt. The runner wraps every file in `BEGIN`, so a
  statement that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`) cannot go through
  it. With few attempts and a reader that never ends, the deploy fails and
  someone must still find and stop the reader.
- The receiver trusts one shared secret, keeps no replay window on signatures, and is a function,
  not a hardened endpoint. Idempotency is on the event id; the same event under a new id is
  handled twice. The dry run proves nothing about handlers with effects outside the database,
  such as sending a message.
- The dispatcher's schedules have no day of month or month and run in UTC. It looks back at most
  a day for a missed run. Two dispatchers ticking at once could both run a job; there is no lock
  on the run.
- The reconciliation compares new and expansion only. Its causes are the ones this data needs; a
  real ledger finds more.
