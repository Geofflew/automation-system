# Run the example

[Back to the overview](../README.md)


Use Node 22+, pnpm 11, Git, and a dedicated disposable PostgreSQL database. Create the database
first; generators and tests rebuild example schemas. Do not point them at an application database.

```sh
export DATABASE_URL=postgres://user@127.0.0.1:5432/acme_ops   # any Postgres 14+, a user that may create a role
pnpm i && pnpm generate && pnpm demo                          # about 10 s; then pnpm test (tsc, 20 tests)
```

No key, account or model call. Part 4 of the output, the lead mechanism. `m4-long-reader` holds an
open transaction that has read `open_deals`; migration 004 redefines it. Every connection has a
hard timeout, so the broken half ends.

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
blocks it. The wait times are real and vary between runs, so the demo prints only bounds ("under
1 s") and its output is the same every time. All seven parts, unedited, are in
[docs/demo-output.md](demo-output.md). Part 5 creates the role `acme_ops_landing_writer` and
drops it when it ends (only if this run created it).
