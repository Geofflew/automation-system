# Combined example review

Reviewed October 19, 2026. This repository combines the AI workflow and data-operation examples under one automation-system explanation.

## Integration verification

- Frozen-lockfile installation passed with pnpm 11.25.0 and Node 22.23.3.
- Root test command passed TypeScript checks and all 46 tests: 26 AI-workflow tests and 20 data-operation tests, sequentially against a dedicated PostgreSQL database.
- Root generation and demo commands passed. Two full demo runs were byte-identical, and each matched its saved transcript.
- Source, tests, and scripts were compared with the prepared source repositories: unchanged.
- Local Markdown links resolve. The overview SVG and rendered PNG were inspected.
- Secret scan passed on the combined working tree.

## Writing and independent review

A writer agent created one Situation → Complication → Our Answer narrative. It explains how requests, events, and scheduled work become useful outcomes, how models and application code divide responsibility, and how state and operational checks support completion.

Independent of that writer, all five review roles concluded ready for author review: editorial clarity, engineering value, technical accuracy, repository essence, and diagram accuracy. The diagram reviewer was independent of its author. No material findings remain. The explanation identifies the implementation as separate runnable examples of a common design rather than a single connected deployed engine.

The original detailed articles remain in each example's docs/guide.md; the main README is the canonical introduction. Publication was subsequently authorized by the owner. The replacement repository is prepared from a fresh snapshot with one initial commit and no prior Git history.
