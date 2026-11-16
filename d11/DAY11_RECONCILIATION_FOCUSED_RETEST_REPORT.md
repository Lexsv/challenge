# Day 11 — Focused Independent Live QA Retest & Test Session Cleanup

**Final verdict: PASS — DAY 11 MEMORY INTEGRITY VERIFIED**

November 16, 2026. Recommend Day 11 acceptance for the exercised scope. The requested live cases, SQLite inspection, source/version relationships, cleanup and restart checks passed. This is sampled real-provider verification, not a claim of universal semantic reliability.

## 1. Environment and inspected fix

- Project: `/Users/lex/challenge/d11`; existing app `http://127.0.0.1:5175/` → **Labs → Week 3**.
- Direct Playwright MCP, isolated browser context `day11-focused-canonical-qa`.
- Existing authorized **OpenAI** provider; requested and reported model **gpt-5.6-terra** on all **47 real generation calls**. No response substitution, manually seeded facts, added agents, or extra application LLM calls.
- Existing backend port **3003** and existing `d11/data/sessions.sqlite`; no new application database or storage routing introduced.
- Read `DAY11_RECONCILIATION_LIVE_QA_REPORT.md`, `DAY11_VERSIONING_RETEST_REPORT.md`, and `DAY11_LIVE_QA_REPORT.md`; inspected `src/session-memory.ts`, `src/week3-reconciliation.test.ts`, and `src/week3-reconciliation-sqlite.test.ts`.
- All source reads excluded environment/credential files. Credentials, keys, request/response headers and opaque reasoning/encrypted output were not inspected or saved.
- Captured provider-format synthetic requests, returned text, status, usage/model and timestamps at browser → application provider proxy → returned response. Backend → upstream payloads were not independently captured.
- Direct SQLite inspection used `mode=ro`, selecting only exact known QA session IDs or the current run's five exact names. All deletion was through the existing application UI, not direct SQL.
- No application source, tests, dependencies or configuration modified. **215 source/config/public files** match before/after hashes. Day 10 was not modified. No commit, push, reset or unrelated changes discarded.

### Identity-normalization review

The fix strips possessive formatting, normalizes whitespace/case, and removes only an exact repeated attribute suffix when the subject already contains that property. It retains subject and scope tokens: the equivalent project-deadline representations normalize together, while Alex/Mark and project/release remain distinct. The existing indexed reconciliation target remains canonical rather than introducing a new identity.

The new Manager/SQLite regression test explicitly forces the formerly failing extractor shape `Mark's project deadline / deadline`, repeats the update, adds separate release/Alex facts and checks persistence after restart. Its provider is mocked. The live tests below independently verify actual model outputs and persisted state.

## 2. Safe cleanup audit

Before cleanup there were **6 Week 3 sessions and 0 Week 2 sessions**. Every existing Week 3 session was positively identified as the immediately prior independent QA run. Each matched the archived session ID, exact title, exact creation timestamp, and complete ordered user-input sequence. There were **0 uncertain sessions** and no user-owned session was selected.

Before deletion, `cleanup-before.json` saved their metadata, events and memory, and `cleanup-manifest-before.json` recorded exact IDs and ownership checks. Existing prior reports/evidence were not altered.

| Confirmed obsolete ID | Prior QA title | Created UTC | Verification |
|---|---|---|---|
| 1d7ca3a4-f0a3-4422-bec8-75fd7fcc3960 | Reconciliation QA — A B — 20261116 | 2026-11-16T20:05:08.548000+00:00 | Exact ID/title/time and 9 inputs matched |
| 2bb8720c-40b7-4a26-94a7-74a0af2208fb | Reconciliation QA — C changed — 20261116 | 2026-11-16T20:06:55.682000+00:00 | Exact ID/title/time and 3 inputs matched |
| cb9bee0f-cae7-4943-83f4-a08dc4a5dbd3 | Reconciliation QA — C moved — 20261116 | 2026-11-16T20:07:35.134000+00:00 | Exact ID/title/time and 3 inputs matched |
| fe31ecfa-9cc4-4b52-bc9e-e899533c761f | Reconciliation QA — C revised — 20261116 | 2026-11-16T20:08:04.035000+00:00 | Exact ID/title/time and 3 inputs matched |
| 0cbf89dc-566f-4184-bab8-f2031181a0cd | Reconciliation QA — D guards — 20261116 | 2026-11-16T20:08:38.964000+00:00 | Exact ID/title/time and 7 inputs matched |
| 25294afe-7398-4d6d-9fa0-4cc0c12c0eb6 | Reconciliation QA — E ordinary — 20261116 | 2026-11-16T20:10:32.505000+00:00 | Exact ID/title/time and 4 inputs matched |

All six IDs above were deleted through **Actions → Delete → confirmation**. Before each action the row's ID/title was rechecked. Each deleted ID's events and memory endpoints returned **404**; read-only SQLite queries filtered to those six IDs found **0 session, 0 history and 0 memory rows**. No broad deletion query, schema change, database reset or configuration operation was used.

- Successfully deleted IDs: **all six listed above**.
- Preserved because ownership was uncertain: **[]**.
- Immediately after cleanup: **0 Week 3 / 0 Week 2 sessions**.
- At completion: **5 current-run Week 3 sessions retained**, none deleted.

Other earlier reports describe sessions in prior isolated temporary databases; their IDs were absent from this application's listing. Those other databases were not opened for deletion or reset.

## 3. Fresh automated verification

| Check | Result | Duration |
|---|---|---|
| Focused reconciliation + Manager/SQLite tests | **9 passed, 2 files, 0 failed, exit 0** | 0.835 s |
| Full Vitest suite | **607 passed, 92 files, 0 failed, exit 0** | 11.30 s |
| SQLite integration tests | **7 passed, 0 failed/skipped/cancelled, exit 0** | 1.202 s |
| TypeScript | **PASS, exit 0** | `tsc --noEmit` |
| Production build | **PASS, exit 0** | 4.27 s; existing >500 kB chunk warning |

Executed against a temporary source copy with installed dependencies and the tests' existing isolated temporary SQLite fixtures. No additional application database was introduced. Commands:

```sh
./node_modules/.bin/vitest run src/week3-reconciliation.test.ts src/week3-reconciliation-sqlite.test.ts --configLoader native
./node_modules/.bin/vitest run --configLoader native
node --test server/session-integration.mjs server/sliding-integration.mjs server/week3-integration.mjs server/branch-api-integration.mjs server/context-workspaces-integration.mjs server/custom-functions-integration.mjs
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build --configLoader native
```

TypeScript and Vite together cover both production-build steps. These are newly executed results, distinct from earlier 606/605-test reports. Mocked-provider tests are not counted as live verification.

## 4. Live scenario verdicts

| Scenario | Result | Observed SQLite behavior |
|---|---|---|
| A — revised wording | **PASS** | One current December 2 fact; November 28 historical; sources intact |
| B — identical repeated correction | **PASS** | Same identity; two current source IDs; unchanged single historical entry |
| C1 — has changed | **PASS** | One canonical current December 2 fact with November 28 history |
| C1 — We moved | **PASS** | Alternate extracted key reconciled into original identity/history |
| C1 — has been revised | **PASS**, covered by fresh A session | No separate duplicate campaign performed |
| C2 — Alex/Mark clarification | **PASS** | Alex Nov 25; Mark Nov 30 current / Nov 28 historical |
| C3 — scope isolation | **PASS** | Only Mark project updated; Alex project and Mark release byte-identical after update |
| C4 — ambiguity/hypothetical | **PASS** | Clarification/no confirmed overwrite; possibilities remain assumed |
| D — restart | **PASS** | All records identical, no new calls/facts/duplicates; sources preserved |

All **19 Manager turns completed** and all **47 actual provider requests returned HTTP 200**. No live case was substituted with a mock or left unexecuted.

## 5. Tests A and B — actual Manager and SQLite evidence

Fresh session **Focused QA — A B revised — 20261116**, ID `9d1240f6-3010-487c-8c47-bc78686dd367`.

| Exact input | Actual Manager response |
|---|---|
| Mark's project deadline is November 28, 2026. | Noted: Mark’s project deadline is November 28, 2026. |
| Mark's project deadline has been revised to December 2, 2026. | Understood—Mark’s project deadline is now December 2, 2026, replacing November 28, 2026. |
| Mark's project deadline has been revised to December 2, 2026. | Mark’s project deadline remains December 2, 2026. |

After A, memory revision **6** had one current December 2 fact and one November 28 history entry. After B, revision **9**, the canonical subject/attribute and history were unchanged; only the repeated correction's source ID was added to the existing current record.

```json
[
  {
    "subject": "Mark's project",
    "attribute": "deadline",
    "value": "December 2, 2026",
    "status": "confirmed",
    "correction": true,
    "sources": [
      "1175b188-88c1-4196-928c-c56e26ffc69e",
      "0de6d2e3-8d59-41ae-9953-61c05f009094"
    ],
    "supersedes": [
      {
        "value": "November 28, 2026",
        "status": "confirmed",
        "sources": [
          "e47b11f1-c3fc-4093-8238-905544144510"
        ]
      }
    ]
  }
]
```

Initial extraction chose canonical `Mark's project / deadline`; that exact identity remained stable. Update reconciliation call **4** returned `update`, target 0, value December 2, with the exact update sentence as evidence. The repeat's reconciliation call **7** returned `confirm`. There was no extra current fact under `Mark's project deadline / deadline` or another equivalent identity, and no unnecessary December 2 historical version.

### Direct source links

| Value/event | Source ID | Relationship |
|---|---|---|
| Original November 28 | e47b11f1-c3fc-4093-8238-905544144510 | Historical, confirmed |
| Revised December 2 | 1175b188-88c1-4196-928c-c56e26ffc69e | Current, confirmed |
| Repeated December 2 | 0de6d2e3-8d59-41ae-9953-61c05f009094 | Added to same current fact |

## 6. Test C — short live regressions

### C1 — has changed — PASS

Fresh session **Focused QA — C changed — 20261116**, ID `6323e6fe-9a85-443b-9bf0-1f87f7a60ee6`.

| Exact input | Actual Manager response |
|---|---|
| Mark's project deadline is November 28, 2026. | Noted: Mark’s project deadline is November 28, 2026. |
| Mark's project deadline has changed to December 2, 2026. | Updated: Mark’s project deadline is December 2, 2026. |

```json
[
  {
    "subject": "Mark's project",
    "attribute": "deadline",
    "value": "December 2, 2026",
    "status": "confirmed",
    "correction": true,
    "sources": [
      "6e3d1c1e-06fc-417a-af26-a8d28660a56c"
    ],
    "supersedes": [
      {
        "value": "November 28, 2026",
        "status": "confirmed",
        "sources": [
          "56bafc6f-2262-4fc0-85ca-ae04035a059a"
        ]
      }
    ]
  }
]
```

### C1 — We moved — PASS

Fresh session **Focused QA — C moved — 20261116**, ID `fbbdbd73-1e3a-41bb-a406-53b210440aad`.

| Exact input | Actual Manager response |
|---|---|
| Mark's project deadline is November 28, 2026. | Noted: Mark’s project deadline is November 28, 2026. |
| We moved Mark's project deadline to December 2, 2026. | Understood — Mark’s project deadline is December 2, 2026. |

```json
[
  {
    "subject": "Mark",
    "attribute": "project deadline",
    "value": "December 2, 2026",
    "status": "confirmed",
    "correction": true,
    "sources": [
      "8723c181-9e9d-4f19-b950-f20daf30dd6a"
    ],
    "supersedes": [
      {
        "value": "November 28, 2026",
        "status": "confirmed",
        "sources": [
          "7a4caf2f-913e-47f6-aad6-abadb94b6819"
        ]
      }
    ]
  }
]
```

“Has been revised” was tested in the fresh A session above, including its repeat in B. The three wording cases therefore used three fresh sessions without needlessly replaying the whole prior campaign.

### C2 — clarification — PASS

Fresh session **Focused QA — clarification — 20261116**, ID `85eac307-5ec6-44eb-9b77-1df699cdc47f`.

| Exact input | Actual Manager response |
|---|---|
| Alex's deadline is November 25, 2026. | Noted: Alex’s deadline is November 25, 2026. |
| Mark's deadline is November 28, 2026. | Noted: Mark’s deadline is November 28, 2026. |
| Alex discussed the project with Mark. He decided to postpone the deadline. | Who decided to postpone the deadline—Alex or Mark? |
| Mark. His deadline is now November 30, 2026. | Noted: Mark decided to postpone his deadline to November 30, 2026. |
| What are Alex's deadline, Mark's current deadline, and Mark's previous deadline? | - Alex’s deadline: November 25, 2026  <br>- Mark’s current deadline: November 30, 2026  <br>- Mark’s previous deadline: November 28, 2026 |

```json
[
  {
    "subject": "Alex",
    "attribute": "deadline",
    "value": "November 25, 2026",
    "status": "confirmed",
    "correction": false,
    "sources": [
      "9c7d0e0d-d6e6-4322-9768-d4a4c211db9c"
    ]
  },
  {
    "subject": "Alex",
    "attribute": "discussed the project with",
    "value": "Mark",
    "status": "confirmed",
    "correction": false,
    "sources": [
      "73e4b42e-6b9b-4208-a8ce-629bdfd79e67"
    ]
  },
  {
    "subject": "Mark",
    "attribute": "deadline",
    "value": "November 30, 2026",
    "status": "confirmed",
    "correction": true,
    "sources": [
      "a7bf189c-9eec-4a91-8880-b3a9f653f85a"
    ],
    "supersedes": [
      {
        "value": "November 28, 2026",
        "status": "confirmed",
        "sources": [
          "99bcf002-45db-4799-8fdd-e8d11f799d84"
        ]
      }
    ]
  }
]
```

The ambiguous sentence caused no unsupported deadline update. The Manager asked Alex or Mark. After the named clarification, extraction returned a supported November 30 fact with a false correction flag; reconciliation call **27** returned `update` to the existing Mark identity. SQLite has November 30 current with the original November 28 source preserved under `supersedes`. Alex is unchanged.

### C3/C4 — scope isolation and safeguards — PASS

Fresh session **Focused QA — scope guards — 20261116**, ID `5b4ec43d-33c3-4c71-be03-d7be2740c68c`.

| Exact input | Actual Manager response |
|---|---|
| Alex's project deadline is November 20, 2026. | Noted: Alex’s project deadline is November 20, 2026. |
| Mark's project deadline is November 28, 2026. | Noted: Mark’s project deadline is November 28, 2026. |
| Mark's release deadline is January 10, 2027. | Noted: Mark’s release deadline is January 10, 2027. |
| Mark's project deadline has been revised to December 2, 2026. | Noted: Mark’s project deadline is now December 2, 2026, replacing November 28, 2026. |
| Alex talked to Mark. He decided to move the project deadline to December 9, 2026. | Who decided to move the project deadline—Alex or Mark? |
| Mark's project deadline might change to December 12, 2026 if testing slips. No change is agreed. | Mark’s confirmed project deadline remains December 2, 2026. December 12, 2026 is only a possible date if testing slips; no change has been agreed. |
| What are Alex's project deadline, Mark's project deadline, and Mark's release deadline? | - Alex’s project deadline: November 20, 2026  <br>- Mark’s project deadline: December 2, 2026  <br>- Mark’s release deadline: January 10, 2027 |

Before the explicit update, there were three confirmed deadline identities. After updating Mark's project deadline, Alex's project deadline and Mark's release deadline were **exactly unchanged, including their sources**. The Mark project identity retained November 28 as history. The final answer independently returned all three correct scoped dates.

```json
[
  {
    "subject": "Alex",
    "attribute": "project deadline",
    "value": "November 20, 2026",
    "status": "confirmed",
    "correction": false,
    "sources": [
      "9a30da8b-d181-47d7-be8d-e5f58a847004"
    ]
  },
  {
    "subject": "Mark",
    "attribute": "release deadline",
    "value": "January 10, 2027",
    "status": "confirmed",
    "correction": false,
    "sources": [
      "ea1c8b3f-a842-4cfb-900e-e837d9f99c6a"
    ]
  },
  {
    "subject": "Mark",
    "attribute": "project deadline",
    "value": "December 2, 2026",
    "status": "confirmed",
    "correction": true,
    "sources": [
      "49691777-5fe3-42b9-9c9f-883e66d32f73"
    ],
    "supersedes": [
      {
        "value": "November 28, 2026",
        "status": "confirmed",
        "sources": [
          "bbcc5f29-6362-41a2-a210-0bf634b17f70"
        ]
      }
    ]
  },
  {
    "subject": "Alex",
    "attribute": "talked to",
    "value": "Mark",
    "status": "confirmed",
    "correction": false,
    "sources": [
      "d70c2a8f-575e-4e7d-9ab9-4241836d4724"
    ]
  },
  {
    "subject": "Mark's project deadline",
    "attribute": "possible new deadline",
    "value": "December 12, 2026",
    "status": "assumed",
    "correction": false,
    "sources": [
      "d4e54d2e-c2b2-42b0-9825-dc8406a57ba0"
    ]
  },
  {
    "subject": "Mark's project deadline",
    "attribute": "agreed change",
    "value": "No change is agreed",
    "status": "assumed",
    "correction": false,
    "sources": [
      "d4e54d2e-c2b2-42b0-9825-dc8406a57ba0"
    ]
  }
]
```

The ambiguous December 9 statement prompted clarification and saved no December 9 deadline. The hypothetical December 12 statement did not change the confirmed deadline. Its possibility and “No change is agreed” context were retained conservatively as **assumed** records; they are not duplicate current confirmed deadlines. A supported Alex/Mark conversation relation is also stored, distinct from deadline facts.

## 7. Test D — actual restart verification

- Confirmed the existing backend belonged to `/Users/lex/challenge/d11` before stopping it.
- Restarted the same app/backend and same SQLite database: **PID 24869 → 28771**; reloaded the frontend.
- Reopened **all five current-run sessions**, then left the A/B session selected for manual inspection.
- Read-only SQLite before/after JSON was **identical** for full memory, facts/history, revisions, original messages, runs and meters.
- Model-generation count stayed **47 → 47**. No new fact, reprocessing, or duplicate appeared during restoration.
- All **18 saved current/historical source references** resolve to original user messages in their owning session.
- Exactly one current confirmed deadline per relevant identity/scope remains; complete history/source links survive.

The report includes both full before and after records, not merely an assertion that reload succeeded. The application is left running and all current QA sessions are retained.

### Before/after persisted record comparison

| Session | Revision before → after | Confirmed deadline records before and after |
|---|---:|---|
| Focused QA — A B revised — 20261116 | 9 → 9 | Mark's project / deadline = December 2, 2026; historical November 28, 2026 |
| Focused QA — C changed — 20261116 | 6 → 6 | Mark's project / deadline = December 2, 2026; historical November 28, 2026 |
| Focused QA — C moved — 20261116 | 6 → 6 | Mark / project deadline = December 2, 2026; historical November 28, 2026 |
| Focused QA — clarification — 20261116 | 15 → 15 | Alex / deadline = November 25, 2026<br>Mark / deadline = November 30, 2026; historical November 28, 2026 |
| Focused QA — scope guards — 20261116 | 21 → 21 | Alex / project deadline = November 20, 2026<br>Mark / release deadline = January 10, 2027<br>Mark / project deadline = December 2, 2026; historical November 28, 2026 |

The complete record arrays, source IDs, histories, and original events are identical in the linked before/after snapshots. Assumed possibilities remain assumed and are excluded from the confirmed-current count above.

## 8. Retained current-run sessions

| Session | Retained ID | Final memory revision |
|---|---|---:|
| Focused QA — A B revised — 20261116 | 9d1240f6-3010-487c-8c47-bc78686dd367 | 9 |
| Focused QA — C changed — 20261116 | 6323e6fe-9a85-443b-9bf0-1f87f7a60ee6 | 6 |
| Focused QA — C moved — 20261116 | fbbdbd73-1e3a-41bb-a406-53b210440aad | 6 |
| Focused QA — clarification — 20261116 | 85eac307-5ec6-44eb-9b77-1df699cdc47f | 15 |
| Focused QA — scope guards — 20261116 | 5b4ec43d-33c3-4c71-be03-d7be2740c68c | 21 |

Final application counts: Week 2 sessions/events **0/0**; Week 3 sessions **5**, history events **170**, memory rows **5**. Current sessions were never cleanup targets. No configuration, provider setting or credential operation was used for cleanup.

## 9. Live request, token and timing measurements

Provider-reported usage was available for every call and matched deduplicated SQLite meters. Reconciliation is logged by the app under `requestKind:extraction`; QA separates extraction and reconciliation by the actual observed prompt (`Extract facts...` versus `Compare the current...`).

| Scenario | Total requests | Answer | Extraction | Reconciliation | Input / output tokens | Active Manager s | Reconciliation request s |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 5 | 2 | 2 | 1 | 1506 / 343 | 14.223 | 2.079 |
| B | 3 | 1 | 1 | 1 | 1042 / 232 | 32.318 | 11.450 |
| C changed | 5 | 2 | 2 | 1 | 1514 / 258 | 47.132 | 7.710 |
| C moved | 5 | 2 | 2 | 1 | 1503 / 265 | 10.773 | 1.707 |
| C clarification | 12 | 5 | 5 | 2 | 4273 / 858 | 28.651 | 6.192 |
| C scope | 11 | 5 | 5 | 1 | 4284 / 608 | 23.640 | 1.950 |
| C guard | 6 | 2 | 2 | 2 | 2794 / 550 | 14.656 | 4.966 |
| TOTAL | 47 | 19 | 19 | 9 | 16916 / 3114 | 171.393 | 36.054 |

Totals include all memory processing: **5,786 input / 2,505 output tokens** for memory, of which reconciliation used **2,839 input / 773 output tokens**. These are already included in the overall **16,916 input / 3,114 output** totals.

Active Manager time is persisted `endedAt - startedAt`, summed without QA pauses: **171.393 s**. Elapsed first-start to last-end time was **333.290 s**, including pauses for inspection. Individual scenario elapsed times are available in `results.json`.

Observed reconciliation request duration totalled **36.054 s** across nine calls, measured from browser request event to reading the returned JSON. The repeat and “has changed” cases had temporarily longer observed provider/request times than other turns. This is not a causal latency increase attributed to reconciliation or this fix: no comparable control baseline was run. No implementation optimization was attempted.

**Monetary cost: NOT VERIFIED / not estimated.** The app supplied no verified price entry for gpt-5.6-terra; no unrelated model's rate was substituted. The focused run used **47**, not a repeat of the prior 70-request campaign.

## 10. Extraction/reconciliation findings and remaining limits

- Indexed reconciliation selected the existing canonical identity and preserved source/version relationships for all requested live updates.
- False extraction correction flags did not prevent supported reconciliation updates.
- No wrong-person update, project/release merge, unsupported confirmed hypothetical, missing required historical value, or duplicate current confirmed deadline was observed in this run.
- **Sampling limitation:** the exact formerly bad live extractor shape `Mark's project deadline / deadline` was **not emitted in these current live update samples**. The focused mocked Manager/SQLite test forces that shape and passes, while the live cases independently demonstrate the requested real inputs, returned outputs, and correct persistence. This limitation is explicit; a mocked pass is not represented as an observed real-provider shape.
- Natural empty extraction on a new corrected value did not occur in this focused run; recovery from that condition remains supported by automated tests and prior architecture review, not newly forced live coverage.
- Broader stochastic reliability, other languages/models/providers, large-context compression, concurrent edits, abrupt power loss and unrelated tools were not retested.
- Backend → upstream request payloads and verified monetary pricing were not independently observed.

No new defect was confirmed. The earlier identity/versioning failures did not recur for the requested live inputs.

## 11. Evidence and reproducibility

Artifact directory: `artifacts/day11-focused-retest-20261116-axmf_xra`.

- [Exact plan](artifacts/day11-focused-retest-20261116-axmf_xra/plan.json)
- [Before-cleanup session/history/memory evidence](artifacts/day11-focused-retest-20261116-axmf_xra/cleanup-before.json)
- [ID ownership manifest recorded before deletion](artifacts/day11-focused-retest-20261116-axmf_xra/cleanup-manifest-before.json)
- [Successful deletions and empty list](artifacts/day11-focused-retest-20261116-axmf_xra/cleanup-after.json)
- [SQLite absence check for the six exact deleted IDs](artifacts/day11-focused-retest-20261116-axmf_xra/cleanup-sqlite-check.json)
- [Current retained IDs](artifacts/day11-focused-retest-20261116-axmf_xra/retained-sessions.json)
- [All Manager replies, facts, source references and performance](artifacts/day11-focused-retest-20261116-axmf_xra/results.json)
- [Sanitized live extraction/reconciliation/answer payloads](artifacts/day11-focused-retest-20261116-axmf_xra/live-captures.json)
- [After A](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-A.json)
- [After B](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-B.json)
- [Has changed](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-C-changed.json)
- [We moved](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-C-moved.json)
- [Clarification before naming subject](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-clarification-ambiguous.json)
- [Clarification final](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-clarification.json)
- [Scope before update](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-scope-before.json)
- [Scope after update](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-scope-update.json)
- [Scope ambiguity](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-scope-ambiguous.json)
- [Scope hypothetical](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-scope-hypothetical.json)
- [Scope final](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-scope-final.json)
- [Actual records before restart](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-before-restart.json)
- [Actual records after restart](artifacts/day11-focused-retest-20261116-axmf_xra/sqlite-after-restart.json)
- [Browser reopening all current sessions](artifacts/day11-focused-retest-20261116-axmf_xra/browser-restart.json)
- [Idempotency/scope assertions](artifacts/day11-focused-retest-20261116-axmf_xra/semantic-checks.json)
- [Source/prior-report/restart verification](artifacts/day11-focused-retest-20261116-axmf_xra/verification.json)
- [Automated result manifest](artifacts/day11-focused-retest-20261116-axmf_xra/automated-results.json)
- [Focused test log](artifacts/day11-focused-retest-20261116-axmf_xra/qa-focused.log)
- [Full test log](artifacts/day11-focused-retest-20261116-axmf_xra/qa-vitest-final.log)
- [SQLite integration log](artifacts/day11-focused-retest-20261116-axmf_xra/qa-sqlite-unsandboxed.log)
- [TypeScript log, exit 0](artifacts/day11-focused-retest-20261116-axmf_xra/qa-typecheck.log)
- [Build log](artifacts/day11-focused-retest-20261116-axmf_xra/qa-build-final.log)
- [Post-restart UI](artifacts/day11-focused-retest-20261116-axmf_xra/final-ui.png)

To reproduce, use the exact inputs in Sections 5–6 in fresh Week 3 sessions with the verified OpenAI connection. Inspect the recorded current-run IDs through the existing memory/events endpoints or read-only SQLite. The old QA sessions intentionally no longer exist; their preserved records and deletion audit remain in the evidence and prior reports.

## 12. Final verdict and recommendation

**PASS — DAY 11 MEMORY INTEGRITY VERIFIED**

Recommend Day 11 acceptance for the tested scope. All required live checks, actual SQLite/source/version inspections, idempotency, scope/ambiguity safeguards, restart verification and fresh automated checks passed. Six positively identified obsolete QA sessions were safely deleted; all five current sessions remain available for independent review.

This recommendation acknowledges the explicit sampling limits above. No architecture change, fix, added LLM application call, commit or push was performed. Stop after testing, cleanup and reporting.

