# AI-assisted workflows

Part of [Building an automation system](../../README.md). These examples automate product answers, account investigations, approved account changes, and support preparation. Models supply interpretations and proposals; application code manages tools, stored progress, and effects.

![Four independent AI-assisted workflows and their outcomes.](docs/pipeline.png)

## Find a workflow

| Workflow | Start reading | What to follow |
| --- | --- | --- |
| Answer unattended product questions | [questions.ts](src/questions.ts) | Discover and claim questions; draft, check, post, refuse, or defer |
| Investigate an account | [analyst.ts](src/analyst.ts) | Execute named tools, return results to the model, conclude or clarify |
| Reassign account owners | [changes.ts](src/changes.ts) | Interpret the request, store a proposal, confirm and apply it |
| Prepare a support note | [triage.ts](src/triage.ts) | Receive an event, retrieve past cases, compose a note, mark processed |

[model.ts](src/model.ts) supplies prepared responses for the model roles, including deliberate failure cases. [schema.sql](src/schema.sql) defines the workflow records, and [db.ts](src/db.ts) records action outcomes. The workflows use synthetic PostgreSQL records rather than live chat or support integrations.

## Run and investigate

[Running instructions](docs/running.md) · [Full explanation](docs/guide.md) · [Mechanisms and tradeoffs](docs/mechanisms.md) · [Detailed limits](docs/limits.md)

[demo.ts](scripts/demo.ts) runs each workflow with and without its application checks. [agents.test.ts](test/agents.test.ts) covers the resulting behavior, including concurrent confirmations and repeated events.

Copyright © 2026 Geoffrey Lew. All rights reserved.
