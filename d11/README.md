# Day 11 AI Lab

Day 11 extends the Day 10 lab with an independent **Labs → Week 3** workspace. Week 3 uses short-term dialogue, a compressed summary, and extracted session facts with the existing Manager, providers, tools, logs, and session statistics. Original dialogue remains in SQLite.

Week 1 and Week 2 remain available. Week 3 sessions, history, and memory use separate `week3_sessions`, `week3_history_events`, and `week3_session_memory` SQLite tables; shared providers and tools remain available across the lab. The complete Week 3 history is loaded when a session opens.

## Run locally

Use Node.js with built-in SQLite support and the project's pnpm dependencies. From `d11/`, run these in separate terminals:

```sh
pnpm server  # SQLite API on 127.0.0.1:3003
pnpm dev     # frontend on 127.0.0.1:5175
```

The database is `d11/data/sessions.sqlite`, separate from Day 10. Configure providers through the application; do not commit databases or credentials.

## Verify

```sh
pnpm test
pnpm typecheck
pnpm build
node --test server/session-integration.mjs server/sliding-integration.mjs server/week3-integration.mjs
```

The Week 3 integration check exercises session isolation and restart persistence. For inherited architecture and tool details, see the [Day 10 README](../d10/README.md).

## Independent QA

The [focused reconciliation retest](DAY11_RECONCILIATION_FOCUSED_RETEST_REPORT.md) records the live-provider and SQLite results. The formerly failing extractor identity was forced in a mocked Manager-to-SQLite regression; that exact identity was not observed in the final live samples. Local QA captures referenced by the report are excluded from Git.
