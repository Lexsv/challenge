# Day 15 — Versioned Memory

The current release is the verified Day 14 baseline. Chat invariants, security logs and Worker sessions retain their existing behavior.

## Planned work

Versioned Memory will add searchable topic cards, timestamped versions of individual fields, a change journal, and retrieval of current or historical values.

## Run locally

From `d15/`, run `pnpm install --frozen-lockfile`. Start `pnpm server` in one terminal and `pnpm dev` in another, both from this directory. Open <http://127.0.0.1:5179>. The frontend proxies API requests to port 3015. The server initializes its own SQLite database at `data/sessions.sqlite`.
