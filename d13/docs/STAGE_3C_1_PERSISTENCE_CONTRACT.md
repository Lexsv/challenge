# Stage 3C.1 — Worker persistence and recovery contract

Status: **proposed design**, not an implemented persistence guarantee. Stage 3B's pure State Machine remains authoritative for domain behavior. No Stage 3C action, event replay, authentication, or recovery path exists yet.

## 1. Current architecture and boundaries

- `src/worker-state-machine.ts` exports `initialWorkerState`, `transition`, and `deriveWorkerReport`. State binds ordered step IDs and visits to attempt history, failures, effective resolutions, and completion. `stateError` is shared internally by transitions and report derivation; invalid report input throws `RangeError`. Validation results are supplied to the core; it performs no I/O.
- `server/worker-repository.mjs` initializes SQLite tables through a savepoint and uses `BEGIN IMMEDIATE` for its existing multi-write repository operations. A Worker session stores `profile_id`, immutable validated `template_snapshot`, `state`, `step_index`, `attempt`, and `revision`; a `not_started` session begins at revision 1. Template edits do not alter snapshots. Existing triggers protect snapshot and profile identity.
- `worker_events` currently has `(session_id, sequence)` as primary key, `UNIQUE(session_id, request_id)`, `action`, optional `step_index`, JSON `payload`, and `created_at`. Existing code reads events; it does not persist Worker action transitions. The schema does not itself validate event versions, revisions, full payloads, or sequence continuity.
- `server/worker-routes.mjs` provides template CRUD and Worker session create/list/read/events, but no actions endpoint. `server/sessions.mjs` owns the connection, routes, and local Host/Origin restrictions. These restrictions are **not authentication**.
- `src/week2-agent-tool-lab.tsx` orchestrates existing Chat's `ManagerAgent`, history restoration, and SessionMemory; Worker pre-start rendering uses `src/worker-ui.tsx`. Chat archive and memory are separate from Worker events. Reuse connection ownership, repository transactions, route conventions, immutable snapshots, and the pure core; do not use Chat summarization as a Worker audit log or couple Worker state mutation to Manager execution.
- `profile_id` references a Context Profile, an instruction profile, not an authenticated principal. Existing profile deletion safeguards enumerate dependencies in `server/profile-deletion-safety.mjs`; any new receipt dependency must be explicitly added and tested.

## 2. Recommended model and alternatives

| Model | Assessment |
| --- | --- |
| A. Ordered events only | Auditable and replayable, but replay on each read/write grows with history; no independently checked current-row projection. |
| B. Latest complete snapshot only | Fast and simple, but cannot reconstruct attempts or independently verify history, idempotent outcomes, and audit evidence after corruption. |
| C. Hybrid | Ordered authoritative events plus the existing small current-state projection. Replay and compare the projection on recovery and before action processing. Atomic updates maintain both. |

Recommend **C**, using full event replay initially, not a separate snapshot framework. The current session row is a projection, not proof of event completeness. No full-state checkpoint or compaction is needed until measured replay cost justifies a versioned checkpoint and independently verified prefix. Storage overhead is linear in accepted transitions; retain events for the lifetime of the Worker. Schema and reducer evolution require explicit version support or an audited migration; never silently reinterpret old events.

This model detects the corruption described below; it cannot prove protection against coordinated alteration of both history and projections by an attacker with database write access. Cryptographic tamper evidence, backup recovery, and authorization are separate concerns.

## 3. Event and receipt contracts

A **command** is an actor's request. An **event** is a server-accepted domain fact. The latest session row is a projection; a report is derived from replayed state. Persist exactly one event per accepted transition. Rejected transitions do not become transition events. The following event kinds use version 1:

| Event kind | Fact and required event-specific fields |
| --- | --- |
| `worker_started` | `stepId`, `stepIndex: 0`, `visit: 1`, `attempt: 1` |
| `validation_accepted`, `validation_rejected` | `stepId`, `stepIndex`, `visit`, `attempt`, submitted `answer`, validator `feedback`, optional sanitized `reason`, outcome, and trusted validator provenance/version |
| `retry_started` | current `stepId`, `stepIndex`, `visit`, previous and new attempt; source `rejection` or `execution_failure` |
| `error_accepted` | current step/index/visit/attempt; references the rejected validation event identity |
| `step_advanced`, `step_revisited` | source and destination step IDs/indexes, previous and resulting visits, resulting attempt; replay derives invalidation |
| `execution_failed` | current step/index/visit/attempt, bounded sanitized failure reason and trusted source |
| `worker_completed` | current step/index/visit/attempt and resulting `passed` or `completed_with_errors` |

Recovery is `retry_started` with source `execution_failure`, not a distinct untracked state. Validation unavailability is not an accepted transition and must not consume an attempt; record its command outcome as a receipt, not a false `validation_rejected` event.

Map an event ID to the existing composite `(session_id, request_id)`; it is unique for the session and no redundant global ID is required. The row's `sequence` is the authoritative ordering, starting at 1. `created_at` is server-supplied audit information only: it is neither an ordering authority nor an input to the reducer. Each payload includes:

```ts
type EventEnvelopeV1 = {
  schemaVersion: 1;
  reducerVersion: 1;
  sessionId: string;              // must equal the row owner
  eventType: string;             // must agree with row action
  expectedRevision: number;      // prior revision
  resultingRevision: number;     // exactly prior + 1
  requestId: string;             // must agree with row request_id
  facts: unknown;                // strict per-kind schema, identities above
};
```

The immutable session snapshot and ordered events are authoritative; session ID, row sequence, and request ID are authoritative row identities, while the payload repeats them to detect inconsistent envelopes. Event facts record outcomes, not executable external calls. `step_index`, visit, attempt, and outcome are bound to pre-transition state and checked, not trusted merely because present. Resulting revision and redundant identities are integrity checks; current index, attempt, resolutions, and report are replay-derived. `step_index` in the row must match the documented event-specific index rule (use the **source/current** step for moves). Start's source is step 0. Event schemas must bound strings, answers, metadata, and serialized JSON.

Example accepted validation row (timestamp omitted here only for brevity):

```json
{
  "session_id": "worker-123", "sequence": 2, "request_id": "request-b",
  "action": "validation_accepted", "step_index": 0,
  "payload": {
    "schemaVersion": 1, "reducerVersion": 1, "sessionId": "worker-123",
    "eventType": "validation_accepted", "requestId": "request-b",
    "expectedRevision": 2, "resultingRevision": 3,
    "facts": {"stepId":"step-1","stepIndex":0,"visit":1,"attempt":1,
      "answer":"option-a","outcome":"accepted","feedback":"Correct",
      "validator":{"kind":"deterministic","version":"1"}}
  }
}
```

### Durable command receipts — proposed schema change

The existing event table only records successful transitions. It **cannot** guarantee that a rejected command using a request ID remains rejected after state changes. Add `worker_command_receipts` in a later migration: `(session_id, request_id)` primary key; session FK with `ON DELETE CASCADE`; `fingerprint_version`, `fingerprint`, `outcome_version`, `outcome_json CHECK(json_valid(outcome_json))`, and `created_at`. Include bounded fields, checks, profile-deletion dependency validation, and explicit cleanup/rollback tests. Store sanitized committed success or deterministic domain rejection (including its original response and resulting/observed revision). Success receipt and event reference one another by the same session/request key and commit atomically; rejection receipt commits without a transition event or revision increment. Unknown schema versions fail closed. Receipt writes themselves require transactional integrity and are not Worker transitions.

Retention: retain receipts for the session's lifetime, including after completion; deleting a Worker with its profile deletes its receipts. This bounds the idempotency promise to the resource's lifetime. Rate/size limits are necessary. Do not delete receipts on a timer while promising lifetime idempotency. Authentication failures, malformed envelopes without a valid key, and transport failures before a durable decision are outside the receipt guarantee; make this explicit to clients.

Example rejected receipt outcome: `{"outcomeVersion":1,"kind":"rejected","code":"invalid_transition","observedRevision":4}`. This rejection remains the response for that request ID even if the session later changes.

## 4. Deterministic recovery

1. In a consistent SQLite read transaction, obtain the Worker session, immutable snapshot and all ordered events; validate snapshot schema/version and owner association. Bind the approved snapshot's ordered step IDs and navigation policy; never substitute a live template or caller-supplied snapshot.
2. Start with `initialWorkerState(snapshot.document.steps.length)` at revision 1. Stage 2B created no initial event: zero events with projection `not_started`, index 0, attempt 1, revision 1 is valid. A noninitial projection with no events is corrupt.
3. Require sequence exactly `1..N`, unique request IDs, supported event and reducer versions, exact row/envelope identities, correct event kind/shape and bounded values. For every event require `expectedRevision` to equal the replay revision and `resultingRevision` to equal it plus one. Validate move identities, validation provenance, step, visit, and attempt against the current replay state.
4. Replay **persisted domain facts**, not raw user commands. A versioned deterministic event-to-`WorkerAction` adapter supplies the recorded validation result to the pure `transition`. This reuses domain invariants without invoking a provider, tool, API, or new write. Verify the derived post-state matches each recorded fact, including completion outcome. Do not trust a recorded result merely because it is well-formed.
5. Reject a failed transition, a post-completion event, a duplicate/missing/out-of-order sequence, revision gap, unsupported event/reducer version, wrong session/step/visit/attempt, malformed payload, or identity mismatch. Do not skip, repair, or fabricate evidence. Differentiate unsupported version from corruption where determinable.
6. Derive the report; catch controlled `RangeError` as an invariant/recovery failure. Compare replayed lifecycle, index, attempt and revision with the stored session projection. Any mismatch is corruption/inconsistency: fail closed, preserve evidence, and do not write. The core's richer `stepIds`, visits, histories and resolutions arise from replay, not from the projection columns.
7. Cross-check accepted event/receipt pairs and receipt fingerprint/outcome consistency; deterministic rejected receipts have no event and do not advance revision. A missing success receipt or an event with an orphaned/mismatched receipt is an integrity failure.

A full replay on every action is the conservative initial approach. Reads that claim complete state/report must likewise replay and validate; a lightweight list may display metadata without claiming recovered state. Define size and event-count limits and measure latency before changing this policy.

## 5. Transaction and idempotency

The requested security guarantee is a **future prerequisite**: authenticate an actor, resolve the Worker and authorize access before revealing receipts or state, and recheck authorization inside the write boundary if it can change concurrently. Current code has no principal or user/session authorization mechanism. Until one is approved and implemented, cross-user access protection cannot be guaranteed and shared multi-user deployment is blocked. A client may supply session ID, request ID, expected revision and action-specific answer/input; it may not supply profile ownership, authoritative state, accepted validation, reconstructed history, or trusted validator identity.

For a synchronous local transition:

1. Authenticate/authorize and validate a bounded command envelope. Canonicalize a **versioned** typed command, including action, normalized payload and expected revision; hash the canonical bytes with SHA-256. Do not fingerprint unstable object key order or secrets. Include actor identity/scope when authorization supports multiple actors.
2. For validation requiring network/AI, capture authorized revision, immutable step and attempt first, then call the trusted validator **outside** the write transaction. Never let a browser supply its result. Calls must be side-effect-free or separately idempotent. Two concurrent duplicates can incur two validator calls; the database contract prevents two committed domain transitions, not duplicate provider cost. External side-effecting execution requires a separate durable operation protocol, not this contract.
3. Start `BEGIN IMMEDIATE` on the existing connection, then recheck ownership/authorization and look up `(session_id, request_id)` **before** revision checking. Same key and same fingerprint returns the stored original sanitized outcome; same key and different fingerprint returns `idempotency_conflict`. Never leak a receipt to an unauthorized caller.
4. If no receipt exists, validate/replay the current history and compare the stored projection. Require `expectedRevision` to equal the authoritative revision. Recheck any validator result's captured revision/step/visit/attempt; discard it on mismatch. Call the pure transition and validate the result/report using the same core invariants.
5. For accepted actions, update the projection with a conditional `WHERE revision = ?`, append exactly one event with next sequence and next revision, and insert the success receipt in the **same transaction**. Require exactly one row updated. For deterministic domain rejection, insert a rejection receipt without changing event history or revision. Commit before responding. Failed validation infrastructure produces a deterministic unavailable receipt for this request ID; a user-initiated new attempt may use a new ID after checking status. Do not persist raw provider details.
6. Roll back on any pre-commit error. SQLite serializes writers under `BEGIN IMMEDIATE`; the revision predicate and unique constraints provide additional conflict protection. No transaction is held across provider calls. If lock acquisition is busy, return a controlled transient result; no hidden retry loop. Do not claim an uncommitted write succeeded.

A process killed before commit leaves neither event nor receipt. A successful commit followed by a lost response leaves both, so a retry with the **same** key and exact command returns the committed result. For an ambiguous commit/storage/transport result, first query a future authorized receipt-status endpoint or resend the identical request ID and payload; absence can be established only by a successful authoritative read. Never assume rollback from a timeout. Concurrent duplicate requests may both perform side-effect-free validation before one wins the transaction; receipt uniqueness and the transaction ensure only one committed action. Same key with a different fingerprint is always a conflict, irrespective of current revision. Optimistic revision prevents different commands from silently overwriting each other; it is distinct from idempotency.

An authenticated, syntactically valid command that reaches domain decision and is rejected (including revision conflict or invalid transition) receives a durable rejection receipt. A later intended action must use a new key and current revision. If receipt persistence fails, return a storage/unknown result, not a durable rejection. Invalid or unauthenticated requests outside this contract must never be represented as durably deduplicated.

## 6. Proposed error contract

| Internal category | Suggested HTTP | Safe retry and status lookup | Corruption? | User-visible message |
| --- | --- | --- | --- | --- |
| `invalid_command` | 400 | Correct input with new ID; no status lookup for an unaccepted envelope | No | Request is invalid. |
| `invalid_transition` | 409 | Stored rejection: same ID returns same result; reload and use a new ID for a different action | No | Action is not available in this state. |
| `revision_conflict` | 409 | Stored rejection; reload current state, then use a new ID | No | Session changed; reload. |
| `idempotency_conflict` | 409 | Never reuse the key with different input; query only if authorized | No | Request identifier was already used. |
| `unauthenticated` / `unauthorized` | 401 / 403 (or indistinguishable 404 by policy) | Authenticate or obtain access; no receipt disclosure | No | Access unavailable. |
| `not_found` | 404 | Verify resource; no blind retry | No | Worker not found. |
| `corrupt_history` | 500 | Do not retry action; operator recovery from verified backup | Possible/yes | Worker history could not be verified. |
| `unsupported_event_version` | 503 | Upgrade/restore compatible reader; query after remedy | Not necessarily | This Worker uses an unsupported history version. |
| `sqlite_busy` | 503 | Retry same key only after a successful status check when outcome is uncertain | No | Storage is busy. |
| `storage_failure` | 500/503 | Query receipt before retry if commit status uncertain | Possible, not assumed | Could not save the action. |
| `unknown_commit` | 503 | Query receipt or resend identical key and payload; do not assume rollback | Not necessarily | Save status is unknown; check again. |
| `internal_invariant` | 500 | Stop action; investigate; map `RangeError` from `deriveWorkerReport` to this or `corrupt_history` according to provenance | Possible/yes | Worker state could not be verified. |
| `validation_unavailable` | 503 | Same ID returns the stored rejection; a deliberate new attempt uses a new ID after state check | No | Validation is temporarily unavailable. |

No SQL, stack traces, raw provider outputs, credentials, or another profile's data appear in responses. A mapping must preserve the distinction between a known no-commit lock error and an uncertain commit.

## 7. Historical QA fixture

The original QA-D04 test changes a freshly started state's `attempt` to `Number.MAX_SAFE_INTEGER` with no corresponding earlier rejection/failure and Retry evidence, then requires validation to succeed. This violates the sequential, evidence-backed active-attempt invariant. Its intended safety objective—Retry must never return an unsafe integer—remains correct. The final independent QA report classified the fixture as obsolete and reports 512 valid Retry scenarios plus direct boundary checks. The historical suite is **14/15**, not fully passing. In a separately approved test-maintenance task, replace that fabricated fixture with a test of valid repeated Retry behavior and a clearly labeled isolated overflow guard boundary; retain the original result as QA history. Do not weaken the domain invariant to satisfy the obsolete setup.

## 8. Implementation sequence and independent acceptance

1. Approve actor/authorization model, event and receipt schemas, validator authority, response retention and error contracts. Until authorization exists, scope any implementation explicitly to the local single-user lab.
2. Add strict versioned event/receipt codecs and deterministic replay adapter as isolated code; test every action, invalid envelope and reducer-version handling with fixtures.
3. Add idempotent receipt storage and event/projection transaction, including deletion-safety graph updates and idempotent migration on disposable databases. No provider calls inside transactions.
4. Add authenticated/authorized action and receipt-status HTTP boundaries, then controlled UI integration only in separately approved stages. Keep Chat paths and existing memories unchanged.

Critical acceptance invariant: **for every successfully committed Worker revision, reconstructing the persisted history produces a domain-equivalent state and report to the original accepted transition.** Automate this by capturing the pure result after every committed action in deterministic generated sequences, closing/reopening the disposable database, replaying from the immutable snapshot, and comparing full state and report after every revision—not only at the end.

Independent QA must cover accepted/rejected validation, Retry, Continue, failure/recovery, repeated Back visits, completion, restart mid-session, event/receipt gaps, duplicates, sequence and revision corruption, unsupported versions, invalid identities, post-completion events, two concurrent different commands, identical concurrent requests, same key/different payload, rollback injection between each write and commit, process interruption before commit, lost response after commit, unauthorized reads/writes/receipt lookups, provider unavailability, report equivalence, and existing Chat/profile deletion regressions. Include payload limits and a measured large-history replay test. Never use real data or live model calls for these checks.

## 9. Decisions requiring approval

- Authentication/principal and authorization model; whether local single-user operation is an explicitly accepted interim limitation.
- Event/reducer versioning and long-term upcaster/migration policy; treatment of previously stored Stage 2B sessions (zero events at revision 1 is valid only for the unchanged initial state).
- Receipt table schema, retention and storage limits; status lookup response and privacy policy.
- Canonicalization and fingerprint definition, including expected revision and actor scope.
- Stable per-session navigation policy: current template snapshot has no explicit Back policy; choose and persist/version a policy before it can differ from the core's current default.
- Trusted validation provenance, deterministic quiz answer-key format, unavailable-result policy, and external side-effect protocol.
- Resource limits, backup/recovery procedure, and whether to add a verified full-state checkpoint after measuring replay cost.
