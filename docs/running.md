# Run the examples

[Back to the overview](../README.md)

Use Node 22+, pnpm 11.25.0, Git, and a dedicated disposable PostgreSQL 14+ database. The database user must be able to create schemas and roles: the data-operations example demonstrates an insert-only role. The generators and tests rebuild example schemas, so use a database containing only these examples.

From the repository root:

```sh
export DATABASE_URL=postgres://user@127.0.0.1:5432/automation_examples
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` runs the AI workflows and data operations in sequence. Both create their own synthetic data. The AI model responses are prepared in code, so no model API key is needed.

Run validation with `pnpm check`. It typechecks and runs the tests in each example, also in sequence. `pnpm generate` creates both datasets without running the demonstrations. Keep these commands sequential against one database because the examples rebuild schemas and the data-operations role is shared across the PostgreSQL server.

To run one example from the repository root:

```sh
pnpm --filter agents-that-know-their-limits demo
pnpm --filter operating-a-live-warehouse test
```

Or enter `examples/ai-workflows` or `examples/data-operations` and run `pnpm demo` or `pnpm test` there after the root install. Commands execute with that example as their working directory. Export `DATABASE_URL` in the shell for the combined run; the root `.env.example` documents the value but is not loaded automatically by the child processes.

Both examples share the root workspace lockfile. Their source, tests, generators, and saved demo transcripts remain separate:

- [AI workflow transcript](../examples/ai-workflows/docs/demo-output.md)
- [Data operations transcript](../examples/data-operations/docs/demo-output.md)

CI uses PostgreSQL 16 and runs both test suites serially. It also runs each demo twice, checks that the two outputs agree, and compares them with the corresponding saved transcript.
