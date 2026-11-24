# Stage 3D.3b — Worker workflow alignment proposal

**Status: proposal for review.** No part of the version-2 workflow below is implemented or verified. Current source and uncommitted work were inspected; the older Stage 3C.1 document is an architecture proposal describing its then-current baseline, not a statement of today's implementation.

## 1. Verified mismatch and boundaries

- `src/worker-state-machine.ts` currently records an answer only as part of a per-step `validate` action. `next` requires the current step's `passed` or `accepted_error` resolution. Back clears effective resolutions from the revisited index onward. Rejected answers use Retry or Continue; `completed` is terminal.
- `src/worker-event-replay.ts` supports only schema/reducer version 1 and version-1 snapshot documents. It reconstructs state by applying recorded facts through the reducer. The stored session row is a checked projection, not the full history.
- `server/worker-transition-repository.mjs` replays before writing, uses `BEGIN IMMEDIATE`, checks revision and receipts, and atomically writes an event, projection and receipt. Its existing trusted per-step validator is synchronous and runs within that transaction. The public action route does not accept trusted verdicts. The status route uses replay and the reducer to provide available actions.
- `server/worker-repository.mjs` accepts version-1 documents containing question prompts/options or action prompts; it enforces immutable per-session snapshots. Existing demo quiz options do **not** contain answer keys, and chocolate steps have no explicit acceptance criteria. The template editor is currently a multiline text editor.
- `server/worker-ai-validator.ts` is an isolated, unwired asynchronous evaluator. It expects an ordered result and nonempty criterion per step, checks a supplied freshness callback, and validates structured findings. It currently validates only version-1 snapshots through the replay codec. It is not a state-machine attestation or an atomic commit mechanism.
- Existing profiles identify Context Profiles, **not authenticated users**. Host/Origin protections provide a local-lab boundary, not multi-user authorization. Chat history and SessionMemory remain separate from Worker events.

The approved workflow requires collection without correctness judgments and a single final evaluation. It cannot be achieved by calling the existing per-step validator or marking submissions accepted: either would fabricate approval and violate the present reducer's invariants.

## 2. Recommended minimal solution

Introduce a version-2 **whole-Worker evaluation mode**, selected by an immutable version-2 template snapshot. Keep the existing four lifecycle states. Add result collection and final-evaluation facts to the pure reducer, replay codec and checked report; leave version-1 semantics intact. A result means only “this step has a syntactically valid submitted response,” never “correct.” The current step must have an effective result before Next. A validated whole-Worker evaluation is a distinct fact and becomes eligible for explicit Complete. A failed evaluation is a domain outcome, not lifecycle `failed`.

No new durable `validating` state is necessary. An in-flight call is transient; the server captures the revision/evidence, invokes AI outside SQLite, then replays and checks them again before any commit. Existing actions may continue concurrently; a changed revision makes the evaluation stale. The UI may disable controls locally during a call, but correctness never depends on that lock.

### Version-2 transition table

| Action | Allowed source and preconditions | Result and history |
| --- | --- | --- |
| Start | `not_started` | `in_progress`, step 0, initial visit/attempt; `worker_started`. |
| Submit result | `in_progress`; current step; valid option ID for a question, or bounded task report/status for an action | Record submission with step, visit and attempt; set current effective result; clear any prior final evaluation. No correctness verdict. |
| Correct result | `in_progress`; current step already has a result; explicit correction | Append a new result linked to the prior result, increment that step visit's submission attempt, replace only effective evidence and invalidate any final evaluation. Preserve prior submissions. |
| Next | `in_progress`; current effective result exists; not final step | Advance exactly one step with a new visit. No validation or implicit completion. |
| Back | `in_progress`; index > 0 and snapshot policy permits | Move back one step, append visit; invalidate effective results from destination onward and any final evaluation, retaining all history. |
| Validate | `in_progress`; on final step; every step has effective result; criteria complete | Server-owned async evaluation; on a fresh valid response append one `worker_evaluated` event and retain its report, still `in_progress`. Validation failure does not advance or consume an attempt. |
| Complete | `in_progress`; current effective evaluation matches all current results and revision-bound snapshot | `completed`; `passed` for zero errors, otherwise `completed_with_errors`. For the latter, the explicit Complete command accepts finishing with errors. |
| Execution failure | `in_progress`; trusted executor attests a technical failure | `failed`, with durable failure evidence. Never use for a wrong answer or unavailable AI. |
| Retry / recovery | `failed`; recoverable failure | Existing recovery semantics return to `in_progress`; preserve failure history. No automatic retry. |
| Any execution action | `completed` | Forbidden; report remains read-only. A new attempt requires a new session. |

No automatic final evaluation or completion is implied. In version 2, the legacy per-step Retry/Continue actions are **not** interpreted as AI verdicts. To correct work after a failed final evaluation, use Back (where allowed), then explicit result submission/correction and a fresh evaluation. Completing an unsuccessful report explicitly accepts remaining errors. Version-1 sessions retain their original Retry/Continue behavior and events; do not convert them or silently start version 2 midway through a session. If retry after final evaluation without Back is desired, define it explicitly before implementation rather than overloading existing Retry.

## 3. Versioned template criteria

Propose document `schemaVersion: 2`, retaining ordered IDs, types, prompts and question options. Add one required `evaluation` per step:

```json
{"schemaVersion":2,"steps":[
  {"id":"q1","type":"question","prompt":"Which language uses Cargo?",
   "options":[{"id":"a","text":"Java"},{"id":"b","text":"Rust"}],
   "evaluation":{"kind":"correct_option","optionId":"b","criteria":"Cargo is the Rust package manager."}},
  {"id":"a1","type":"action","prompt":"Inspect the beans",
   "evaluation":{"kind":"acceptance_criteria","criteria":"Record whether beans are sound and describe any defect."}}
]}
```

The server validates exact keys, bounded text/document sizes, unique step/option IDs, 2–4 choices, `correct_option` referring to an existing option, and nonempty action criteria. Keep the existing visual editor; add minimal per-step controls to select the correct option or enter action criteria, never require raw JSON. Template edits increment the existing version and use optimistic concurrency; a session always uses its original immutable snapshot.

Read version-1 templates/sessions unchanged. No automatic key inference, background rewrite, or snapshot mutation. A version-1 template without explicit criteria cannot start a **new version-2 evaluation session** until a user explicitly supplies and saves criteria as a new template revision. Existing version-1 sessions continue under version-1 rules. Upgrade demonstration templates only through explicit, reviewed criteria and ordinary versioned edits or seed version 2 for fresh databases; never overwrite existing user-modified template rows. A previously created version-1 session cannot be upgraded by editing its template: create a new session. In particular, don't infer the quiz key from option order.

Question submissions store an option **ID**; the trusted evaluator context can include both the ID and its snapshot-derived option text. The current evaluator requires finding evidence to be an exact substring of a result string: define a canonical server-generated representation, e.g. `Selected option b: Rust`, and use it consistently for evaluation and evidence validation. Action reports similarly retain the exact submitted status and text. This mapping must be specified and tested; do not treat an option label as an answer key. The current evaluator must be extended to validate version-2 snapshots and criteria before this design is usable. Nonempty criteria alone cannot prove semantic sufficiency; the evaluator must fail closed on insufficient evidence, and real-model accuracy requires separate QA.

## 4. Events, replay and persistence

Keep existing rows, triggers, immutable snapshots and `worker_events(session_id, sequence, request_id, action, step_index, payload, created_at)`. Extend payloads with **version-2 event and reducer identifiers** and strict exact-field schemas; keep the version-1 decoder/reducer available unchanged. Choose reducer by immutable snapshot/document version and reject mixed histories, unknown versions, row/envelope mismatch, gaps, post-completion events and contradictory evidence. Do not reinterpret legacy `validation_accepted` events as mere collected results.

| Version-2 event | Required domain facts beyond common envelope |
| --- | --- |
| `worker_started` | Step/index, initial visit and attempt. |
| `step_result_submitted` / `step_result_corrected` | Step/index, visit, attempt, exact bounded result (option ID or action status and report); correction references prior submission identity. |
| `step_advanced` / `step_revisited` | Source/destination identity and visit; replay derives effective-result and report invalidation. |
| `execution_failed` / `retry_started` | Trusted failure reason/source or recovery reference, visit and attempt. |
| `worker_evaluated` | Captured source revision and evidence digest, evaluator/schema version, bounded structured evaluation and findings, step IDs, exact evidence references; no raw provider errors or credentials. |
| `worker_completed` | Evaluation event reference and derived `passed` / `completed_with_errors`. |

Common envelope retains session/request IDs, sequence, action/event type, schema and reducer versions, source/result revisions and checked pre/post step/visit/attempt/state. Timestamp is audit metadata, never replay ordering. Replay constructs effective submissions, histories, evaluation and completion solely from snapshot and ordered facts; validates identities, sequential access, criteria and exact evidence; checks evaluation bindings and completion derivation; and compares lifecycle, step, attempt and revision with the existing projection. Replaying cannot call AI or create events. An invalid or unsupported history is reported, never repaired. A final report is derived from the effective evaluation and preserved historical attempts, not from `step_index`.

The existing row has no completion-outcome column. Initially derive outcome and report through replay in checked reads; no column or new table is required for that choice. Existing `worker_command_receipts` remains the durable request/outcome store. The existing fingerprint is version 1 and only covers action plus answer/reason for its known actions; version-2 commands need a **versioned canonical fingerprint** including session ID, expected revision, action, and full normalized action-specific payload. Preserve verification of historical v1 fingerprints and independent receipt/event checks. Decide how to version receipts additively before implementation (e.g. a checked `fingerprint_version` column with a safe v1 default); never overwrite existing fingerprints. New dependency/migration and profile-deletion checks must be tested if a schema change is selected.

## 5. Async AI, revision and idempotency

1. Validate the public command shape and local access boundary; inspect any existing receipt **before** rejecting a stale revision. An identical committed receipt returns its original, explicitly historical outcome; different payload/key reuse returns conflict. Historical events lacking receipts retain the current fail-closed legacy policy.
2. In a consistent read, replay and verify the session, immutable snapshot, current revision, complete effective results, ordered step identities, criteria, and evaluation eligibility. Construct a bounded server-owned context and canonical digest over the session, revision, immutable snapshot/criteria and exact effective result identities/content. The client cannot supply an evaluator result, snapshot, digest, profile ID, or authoritative state.
3. Release the read transaction. Call the configured trusted evaluator asynchronously, without a SQLite write transaction. Model output remains untrusted until strict schema, complete findings, exact identities, evidence references, nonempty feedback and counts are validated. `success` must agree with zero errors. Criteria or evidence insufficient, provider errors, timeout and malformed output cause no verdict, no transition and no consumed user attempt. Evaluator's `isCurrent` check helps but **does not replace** the commit-time check.
4. Begin `IMMEDIATE`; recheck receipt first, replay and verify again, require captured revision and recomputed evidence digest to match, and let the pure reducer authorize the server-owned `evaluation recorded` transition. Atomically append event, conditionally update projection/revision and insert a success receipt. Commit before returning. If an intervening action changed the revision, return a stale-evaluation conflict and discard the result; don't automatically replay it.
5. A lost response after commit is reconciled with the same request ID and identical command. Never claim rollback merely because an HTTP response was lost. Deterministic command rejections can use existing receipt semantics; transient evaluator unavailability must not permanently consume that request ID.

**In-flight limitation:** the current receipts model has no durable in-flight claim. A process-local map keyed by session/request and canonical fingerprint can share the same evaluation promise and reject same-key/different-payload concurrent calls in one server process; clean it on settlement, timeout or failure. Across processes or after restart, the same command can incur duplicate provider calls. `BEGIN IMMEDIATE`, receipt lookup and uniqueness still allow only one committed result, and later callers return that receipt. This is at-most-once *commit*, not exactly-once provider invocation or guaranteed recovery of an uncommitted in-flight call. If avoiding duplicate provider costs across processes/restarts is required, approve a durable claim/lease protocol as a separate change; do not claim the in-memory map provides it. Late timed-out calls must never commit. No background job is required.

## 6. HTTP and React

Extend the existing session-scoped `POST /api/worker-sessions/:id/actions` with strictly validated version-2 commands: `submit_result` (typed payload), `next`, `back`, `evaluate` (empty payload), and `complete` (empty payload); retain Start and trusted failure recovery. All carry `requestId` and `expectedRevision`. Question payload is `{ "optionId": "b" }`; action payload is `{ "status": "completed" | "problem", "report": "..." }`. Correction is either an explicitly typed `correct_result` command or an explicit correction flag, selected before implementation. Reject extra fields, supplied verdicts, provenance, state and outcomes. Never expose internal validator operations. Map invalid input 400, missing resource 404, forbidden/revision/request-ID conflict 409, evaluator unavailable 503, corruption to controlled integrity error, and uncertain commit to a distinct 503; never disclose raw upstream/SQLite errors. Preserve current route methods and v1 behavior.

Extend the checked status response, or add a narrowly scoped read-only report, to return the snapshot-appropriate current step, collected/resolved counts, server-derived available actions, final evaluation/report when present, and revision. Do not leak the correct option or full answer criteria to the answer-taking UI: **the existing session endpoint already exposes the entire template snapshot**, so hiding new keys requires a separately approved sanitized read contract or an explicit local-MVP decision; frontend-only hiding is not security. The local app has no authentication and cannot guarantee user isolation.

React keeps the existing timeline and panel. Render server state and only server-permitted actions. Display radio choices for questions and bounded completion/problem input for actions. Submit result before enabling Next; final step offers Validate only when the server allows it. Show a transient pending state during AI validation, retain the exact request ID/payload for uncertainty, and refresh checked status on success, replay, conflict and restoration. Present findings, reason, error count and explicit Complete; after completion render read-only. A result or evaluation is never optimistically treated as successful. Keep pending state isolated by session and preserve selected Chat/Worker restoration.

## 7. Risks and open decisions

1. **Approve v2 behavior and boundary:** should existing v1 sessions remain legacy forever, and should only newly created sessions use v2? Recommendation: yes; do not reinterpret snapshots or history.
2. **Criteria ownership:** who authors or reviews correct answers and acceptance criteria, including the two demo templates? Recommendation: user-reviewed versioned edits; no invented keys or silent changes to existing rows.
3. **Failed evaluation policy:** does explicit Complete accept all reported errors, or must users acknowledge each? Recommendation: one explicit Complete for the whole report; Back/correct/re-evaluate is optional before completion.
4. **Correction and navigation:** whether correction uses a separate command and how far Back is permitted. Recommendation: separate explicit `correct_result`; retain existing default of one-step Back and invalidate the destination and later results.
5. **Privacy and trust:** the current local-lab API exposes snapshots and lacks authenticated ownership. Approve a sanitized read contract if correct answers must be concealed; authentication is a separate prerequisite for multi-user isolation. Captured results and feedback may contain personal data and inherit Worker event retention/deletion policy.
6. **In-flight idempotency:** single-process singleflight reduces calls but cannot prevent duplicate provider cost after restart or across processes. Decide whether this MVP limitation is acceptable.
7. **Evaluator limitations:** nonempty criteria and structural checks cannot prove factual accuracy or eliminate prompt injection. Evidence substring grounding is not semantic proof; structured outputs and real-model evaluation are needed. Define input/output budgets, sanitization and token accounting before enabling calls.
8. **Receipt migration and compatibility:** approve fingerprint versioning and failure handling for existing v1 receipts; no silent schema or fingerprint reinterpretation. Long histories imply full replay cost; measure before adding checkpoints.

## 8. Implementation sequence and acceptance criteria

1. **Versioned domain and codec:** define v2 documents/results, pure transitions, report and v2 event decoding/replay; preserve v1 fixtures unchanged. Acceptance: valid/forbidden transitions, no skipped steps, Back invalidation, corruption rejection, terminal immutability and original v1 tests pass.
2. **Template criteria:** validate v2 documents, extend visual editing, provide explicitly reviewed demo criteria, and preserve old rows/snapshots. Acceptance: missing/invalid keys rejected, optimistic revision enforced, old templates and sessions remain readable and unchanged.
3. **Transactional collection:** integrate v2 events/projection and versioned command fingerprints/receipts; no AI yet. Acceptance: per-revision replay/report equivalence, atomic failure injection, same-key replay, conflicting key, concurrent expected-revision conflict, restart and profile/Chat regressions.
4. **Trusted evaluation orchestration:** extend evaluator for v2; capture consistent context, call outside transaction, verify freshness and commit one evaluation event with receipt. Acceptance: valid/invalid findings, provider failures, stale results, timeout, duplicate and lost-response cases; no fabricated success or attempt consumed on technical failure. Test same-process singleflight and explicitly test multi-process duplicate-call limitation.
5. **HTTP and React:** strictly validate result/validate/complete commands, provide safe checked status/report, retain per-session pending reconciliation. Acceptance: server-derived control availability, reload and switching, no optimistic success, completed read-only, no client-authored verdict or data leakage under the approved local trust model.

Independent QA must run two complete deterministic mocked-provider scenarios: (1) **Programming Quiz** collects five explicit selected options, rejects skipped/unresolved steps, evaluates all five against reviewed keys, verifies positive and negative reports, completes and restores after restart; (2) **Chocolate Production** records sequential task results including a defect, goes Back to the affected step, verifies subsequent results and prior evaluation are invalidated but history preserved, records the correction, recollects subsequent results, evaluates and completes. Include failure injection before/after event, projection and receipt writes; lost HTTP response; simultaneous commands with same/different IDs; stale revision while AI is pending; provider timeout and malformed output; unsupported event versions; incomplete/mismatched findings; reopening SQLite; report equivalence before/after replay; irreversible terminal actions; existing Chat, profile deletion and General protections. Test both final success and explicit completion with errors.

**Critical invariant:** every committed revision must replay to a domain-equivalent state and report; no accepted result or evaluation may originate from stale, missing, invented or mismatched evidence.
