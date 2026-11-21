# Day 15 — Versioned Memory

Open **Labs → Week 3**, create or select a **Chat** session, and describe a task. The configured chat model can propose a topic card from the first message, refine its description and tags, or propose complete field values.

## Week 3 Chat

The header keeps the session title and settings together. User messages appear on the right and assistant replies on the left. Each bubble shows the saved message time in the reader’s local time zone when available. Messages scroll behind the floating composer, and the final reply scrolls fully above it. Each turn keeps its own Logs.

The right panel starts with **Session Stats**, with the selected model and expandable token, context, security and usage figures. **Session Memory** shows the short-, medium- and long-term layers in an interactive chart. Expand **Topic Cards** to search by description or tag. **View details** opens current values, dated field versions with source evidence, and a chronological change journal.

The source message determines the change time. The date of a trip is an ordinary field value. Ask for the current roster, a numbered roster version, or the roster effective at a particular date change. When the target is ambiguous the extractor can request clarification. The pending source stays in the session memory until resolved. These natural-language decisions depend on the configured model.

Week 3 stores cards in its existing revisioned SQLite chat-memory snapshot. The Manager builds card lookup requests from the selected records. Recent dialogue and the summary help interpret the question. An explicit **Finish active task** clears working context and saves a transcript boundary. Durable cards, the original conversation and session rules survive. Worker sessions use their separate repository.

## Run locally

From `d15/`, run `pnpm install --frozen-lockfile`. Start `pnpm server` and `pnpm dev` in separate terminals. Open <http://127.0.0.1:5179>. The frontend proxies API requests to port 3015. The database is `data/sessions.sqlite`. Configure the chat provider in Providers to run live extraction and answers.

**Reading the memory counters.** Short-term memory holds recent dialogue. Medium-term memory is a reviewed summary of older turns; a turn counts as covered only after its summary is saved. The long-term token estimate describes extracted general facts, such as lasting preferences. Topic cards have a separate count and per-field version numbers. A chat can therefore contain several saved trips and zero general facts.

A lookup tied to an event uses the event's source message and the field record effective at that instant. Current field lookups omit older dialogue and summaries from the answer request. Clarifying an advice question selects the trip and resumes the original question. Confirmed edits record a change; repeating the current value retains the same field version.

Repeating a field value saves its source as a confirmation in the journal. It adds no field version while the effective value stays the same. One message can update several existing cards when each quoted change identifies its own topic. An ambiguous batch saves nothing.

After **Finish active task**, an unrelated question starts with no archived topics in the extraction or answer prompt. A request to return to a saved topic can reopen the catalog. A rule requiring a word in assistant answers still applies to the reply after restart. It does not require that word to be added to every saved field or internal JSON decision.

## Week 3 memory proposals

For Chat turns, the server asks the selected model for a Memory Proposal using the application-owned v1 JSON Schema. A new card can have zero field edits. Existing cards can receive scalar changes, complete rosters, withdrawals, notes and responsibilities. Assignments are stored as source-text notes. A deterministic mapper translates validated proposals into memory operations. The server checks the target and original user evidence, records source-message times and derives complete field versions. A multi-card update commits as one batch. A repeated value produces an already-current confirmation.

The server probes a provider/model with the exact proposal schema and synthetic input before enabling strict output. When strict mode cannot be verified, the application validates prompted JSON against the same contract. Invalid proposals have one bounded repair opportunity. Provider calls take place outside SQLite transactions. The same server turn executor handles sessions with and without invariants; it commits the reviewed transcript, revisioned memory and a session-scoped retry receipt together. A lost response can be reconciled with the original turn ID. Existing SQLite snapshots are read in place.
