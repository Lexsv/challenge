# Day 14 — Invariants

День 14 — Инвариантность

Open a Chat in Labs Week 2 or Week 3. Under **Chat settings → Invariants**, add a rule, edit its text, toggle it, or remove it. These explicit actions update the session's SQLite rule list and audit history. Full Context, Sliding Window, Sticky Facts and other context views share the parent chat's rules. Worker sessions use their existing workflow.

## Security in a chat

- When you send a message, the server checks it against the enabled rules before generating an answer. A blocked question stays in the conversation with its own **Logs · Security** entry. Sending the same question twice creates two separate turns.
- The server also checks the answer and tool results before showing them. Black blocks cover restricted words while the surrounding text stays readable. The server withholds the whole answer when it cannot safely isolate the violation.
- Expand **Logs · Security** on the affected turn to see the amber shield and the reason. Session stats count blocked requests, redacted responses and withheld responses. Changing a rule applies to future messages. It does not resend a question or reveal a previously hidden answer.

Literal word and phrase checks use Unicode normalization and case-insensitive boundaries. Recommendation and free-form architectural rules also use a separate structured policy review. That review can make mistakes. Missing or invalid verdicts fail closed. Changes to rules apply to new turns. Saved history retains the presentation in effect before a settings change. Derived content without evidence of a current semantic review is withheld. The local application uses its existing same-origin settings boundary.

## Enforcement and diagnostic records

The original rule text remains the source of truth. Write a single word or quote a multi-word phrase, for example `Never mention the name Instagram in assistant responses.` or `Never mention "Acme Road".` Ambiguous literal targets require clarification. Enabling contradictory requirements for the same literal is rejected. Existing active contradictions must be resolved in settings before a turn can run.

Literal checks cover normalized text, target-specific visual substitutions, combining marks on plain Latin targets, inserted spaces and separators (including commas, slashes and pipes), single-letter omissions in longer Latin names, joined Markdown text, and recognizable Base64, ROT13 and encoded character representations. Unrelated encoded examples remain readable. These checks have bounded coverage. Arbitrary ciphers, translations and semantic implications cannot be exhaustively recognized. Unavailable or inconclusive mandatory semantic reviews abort the turn.

The server counts each affected turn once per correlation ID and keeps the prompt and model text out of the security log. The status view returns the latest 100 entries and all-time counts for the chat across context strategies. Technical validation failures leave the turn uncommitted and do not increment these counters.

Each rule edit atomically records the previous rules and last saved event sequence for each affected chat stream. History reads, including paginated reads, use the rules for that range. For pre-upgrade data, the starting point is the view available under the policy at upgrade, since former browser views were never recorded. Read-time redaction preserves the historical record and does not add a security event on each view. Credential mutations consume their client revision on admission, including when a store operation subsequently fails. Reconcile the reported provider status and use a fresh revision for a retry.

Server-side memory strategies use published provider limits and a local token estimate. If no usable limit is available, the UI explains the limitation before sending. Existing data stays in place. The additive SQLite table is created at startup and previous content approvals are rechecked under the new enforcement version when history is read.

## Run and verify

Run `pnpm server` and `pnpm dev` in separate terminals. Open <http://127.0.0.1:5178>. The backend listens on port 3014. Configure a provider in Providers for live evaluation.

Run `pnpm test`, `node --test server/*-integration.mjs server/*.node-test.mjs`, `pnpm typecheck`, and `pnpm build`. The invariant integration suite uses temporary databases and deterministic provider fixtures. Its test diagnostics record each adversarial input, rule, expected and observed behavior, and whether prohibited output reached the client.
