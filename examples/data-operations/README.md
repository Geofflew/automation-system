# Data operations

Part of [Building an automation system](../../README.md). These examples show how event processing, scheduled jobs, database changes, and comparisons support automation that people depend on.

![Independent examples for event and scheduled processing, database changes, deployed-state checks, and financial reconciliation.](docs/pipeline.png)

## Find a mechanism

| Question | Start reading | What to follow |
| --- | --- | --- |
| How does an incoming event become completed work? | [landing.ts](src/landing.ts) | Store and acknowledge; claim, process, and mark handled; replay or dry-run |
| How do jobs run and pause independently? | [dispatch.ts](src/dispatch.ts) | Registration, due-work selection, job switches, and run records |
| How can database changes yield to ongoing reads? | [migrate.ts](src/migrate.ts) | Transaction-local lock waits, rollback, retry, and final failure |
| Did the intended definition reach the database? | [drift.ts](src/drift.ts) | Build a scratch schema and compare deployed view/function definitions |
| What assumptions were lost during setup? | [defaults.ts](src/defaults.ts) and [stubs.ts](src/stubs.ts) | Compare column defaults and inspect obsolete NULL placeholders |
| Why do financial results disagree? | [reconcile.ts](src/reconcile.ts) | Apply named comparison rules, then trace differing records to causes |

The examples are independent demonstrations. Event handling records database effects; scheduling uses supplied ticks and example job functions. They illustrate execution and operating decisions without wiring every mechanism into one service.

## Run and investigate

[Running instructions](docs/running.md) · [Full explanation](docs/guide.md) · [Mechanisms and tradeoffs](docs/mechanisms.md) · [Detailed limits](docs/limits.md)

[demo.ts](scripts/demo.ts) reproduces each failure and its correction. [mechanisms.test.ts](test/mechanisms.test.ts) checks event replay, scheduling, lock queues, schema comparisons, and reconciliation.

Copyright © 2026 Geoffrey Lew. All rights reserved.
