import { clarificationSelects, compareSource } from "../src/topic-cards.ts";

// Versioned cards live in the existing revisioned Week 3 memory snapshot.
// Only accept changes supported by a user message in this particular Chat.
export function validCardEvidence(db, sessionId, catalog, previous) {
  if (!catalog) return !previous;
  if (
    !Array.isArray(catalog.cards) ||
    !catalog.cards.every((card) => card && typeof card.id === "string")
  )
    return false;
  const ids = new Set(catalog.cards.map((card) => card.id));
  if (
    ids.size !== catalog.cards.length ||
    (catalog.active && !ids.has(catalog.active)) ||
    catalog.boundary !== previous?.boundary
  )
    return false;
  const rows = db
    .prepare(
      "SELECT payload FROM week3_history_events WHERE sessionId=? AND type='message' ORDER BY sequence",
    )
    .all(sessionId);
  const sources = new Map();
  let order = 0;
  for (const row of rows) {
    const message = JSON.parse(row.payload);
    if (message.blocked) continue;
    order++;
    if (message.role === "user") sources.set(message.id, { message, order });
  }
  function supported(source, quote, start) {
    const row = sources.get(source?.id);
    return (
      !!row &&
      row.message.createdAt === source.at &&
      row.order === source.order &&
      (start === undefined || (Number.isSafeInteger(start) && start >= 0 && typeof quote === "string" &&
        row.message.text.slice(start, start + quote.length) === quote)) &&
      (quote === undefined ||
        (typeof quote === "string" &&
          quote.trim() &&
          row.message.text.includes(quote)))
    );
  }
  if (
    catalog.pending &&
    (!supported(catalog.pending.source, catalog.pending.text) ||
      typeof catalog.pending.question !== "string")
  )
    return false;
  if (catalog.last && !supported(catalog.last)) return false;
  function supportedResolution(change, card) {
    const pending = previous?.pending;
    if (!change.resolvedBy) return pending?.source.id !== change.id;
    if (!pending || pending.intent === "read" || pending.source.id !== change.id ||
        !pending.text.includes(change.evidence) || compareSource(change, change.resolvedBy) >= 0 ||
        !supported(change.resolvedBy, change.resolvedBy.evidence)) return false;
    const reply = sources.get(change.resolvedBy.id).message.text;
    return clarificationSelects(previous.cards, card.id, reply) &&
      clarificationSelects(previous.cards, card.id, change.resolvedBy.evidence ?? reply);
  }
  const previousCards = new Map((previous?.cards ?? []).map(card => [card.id, card]));
  if ([...previousCards.keys()].some(id => !ids.has(id))) return false;
  for (const card of catalog.cards) {
    if (
      !sources.has(card.id) ||
      typeof card.description !== "string" ||
      !card.description.trim() ||
      !Array.isArray(card.tags) ||
      !card.tags.every((t) => typeof t === "string" && t.trim()) ||
      !Array.isArray(card.changes)
    )
      return false;
    // Protected turns may already have sanitized a quote. Keep that approved
    // prefix byte-for-byte and verify new evidence against the source messages.
    const old = previousCards.get(card.id);
    const recorded = new Set();
    for (const bucket of ["changes", "confirmations"]) {
      const prefix = old?.[bucket] ?? [];
      const next = card[bucket] ?? [];
      if (!Array.isArray(next) || next.length < prefix.length) return false;
      for (const [index, change] of next.entries()) {
        if (index < prefix.length) {
          if (JSON.stringify(change) !== JSON.stringify(prefix[index])) return false;
        } else {
          if (
            !change ||
            typeof change.evidence !== "string" ||
            !supported(change, change.evidence, change.evidenceStart) ||
            !supportedResolution(change, card) ||
            typeof change.field !== "string" ||
            !change.field.trim() ||
            !(
              typeof change.value === "string" ||
              (Array.isArray(change.value) &&
                change.value.every((v) => typeof v === "string"))
            )
          )
            return false;
        }
        const key = JSON.stringify([change.id, change.field]);
        if (recorded.has(key)) return false;
        recorded.add(key);
      }
    }
  }
  return true;
}
