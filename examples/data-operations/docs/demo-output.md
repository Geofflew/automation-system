# Full demo output

What `pnpm generate && pnpm demo` prints, unedited. It is byte-identical on every run: the generator is seeded, dates are relative to a fixed anchor, part 6 uses logical times, and part 4 prints timings only as bounds. The README quotes part 4; [mechanisms.md](mechanisms.md) quotes each part next to its explanation.

```

=== 1. Edit after apply
production ran 001-003. open_deals includes 12 won deals (the bug).
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

=== 2. NULL stubs
tickets.product_type was added and filled after support.ticket_facts was written with NULL::text AS product_type.
BROKEN   the screen shows filters: status, priority   (product_type hidden: every value is NULL, no error anywhere)
GUARDED  finding: ticket_facts.product_type is NULL::text, but support.tickets.product_type exists (240 of 240 rows filled)
         not reported: ticket_facts.sentiment is also NULL::text, and no table it reads has a sentiment column
         after re-issuing the view: filters status, priority, product_type; findings now 0

=== 3. Lost defaults
a copy tool made app_live's tables; the baseline's ADD COLUMN IF NOT EXISTS then skipped every column it had made.
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

=== 4. Lock queue
m4-long-reader opens a transaction and reads open_deals (an export that has not finished). Migration 004 redefines open_deals.
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

=== 5. Event landing
BROKEN   receiver does the work inline (300 ms); the sender waits 100 ms, then retries, 3 attempts.
         evt_1001: 3 deliveries, the work ran 3 times
GUARDED  store-then-ack: evt_1001 answered on attempt 1; a redelivery -> 200; a bad signature -> 401; rows stored: 1
         stored by role acme_ops_landing_writer; that role reading the table: permission denied for table events
         4 more events. Sweep-only, every 60 s (computed from where each lands in the minute): handled 23500, 27500, 38500, 52500 ms after landing; worst case 60000
         notify on insert (measured): every event handled under 250 ms after it was stored
         replay (handled = false on all 5, drained again): effects 5 -> 5
         dry run of evt_2001: would write 1 effect (reply for Quiet Meadow Co); effects still 5, event still unhandled: true

=== 6. One schedule, many jobs
someone switches off "crm-sync" on the jobs screen, whose label says "duplicate detection (does not stop the sync)".
BROKEN   old host (calls every route on its schedule; the route reads the switch): 14 days, sync 14 runs, dedupe 0
         new host (one schedule; dispatcher ticks every 30 min, skips switched-off names): 14 days, sync 0 runs, dedupe 0
           crm-sync        runs  0  last -                 WARN no runs logged since 2026-06-15 (switched off)
           nightly-rollup  runs 14  last 2026-06-28 02:30
GUARDED  duplicate detection is its own job, crm-dedupe, and that is the name switched off. 14 days: sync 14 runs, dedupe 0
           crm-dedupe      runs  0  last -                 WARN no runs logged since 2026-06-15 (switched off)
           crm-sync        runs 14  last 2026-06-28 06:00
           nightly-rollup  runs 14  last 2026-06-28 02:30
         the switch row missing at a tick where crm-sync is due: ran 0; no disabled_jobs row; running nothing until one exists

=== 7. Reconciliation
ledger rebuilt from 180 deal events; finance workbook has 180 rows. New and expansion, per quarter:
  no rules                                                               1 of 12 quarters match exactly
  the services line folded into expansion                                4 of 12 quarters match exactly
  the services line folded into expansion + win-backs counted as new     10 of 12 quarters match exactly
BROKEN   with no rules, the two disagree in 11 quarters and nothing says why.
GUARDED  both rules, deal by deal: 174 of 180 workbook rows match a ledger row exactly.
           2026-Q1: new 33850 vs 41900, expansion 4800 vs 10400
           2026-Q2: new 14650 vs 23750, expansion 1750 vs 1750
           D-0023 2026-01-12 new       workbook 2900, ledger -: deal has no company link; the ledger reads deals through companies
           D-0046 2026-02-01 new       workbook 2100, ledger -: deal has no company link; the ledger reads deals through companies
           D-0069 2026-03-03 expansion workbook 5600, ledger -: deal has no company link; the ledger reads deals through companies
           D-0092 2026-03-28 new       workbook 3050, ledger -: deal has no company link; the ledger reads deals through companies
           D-0115 2026-05-02 new       workbook 4950, ledger -: deal has no company link; the ledger reads deals through companies
           D-0138 2026-06-11 new       workbook 4150, ledger -: deal has no company link; the ledger reads deals through companies
         10 of 12 quarters match exactly; residual 22750 traced to 6 rows
```
