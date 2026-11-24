import { canonicalDay, checkFieldClaim, GroundingError, locateEvidence, quoteForms } from './topic-evidence.ts';
export type Source = { id: string; at: number; order: number };
export type Change = Source & {
  field: string;
  resolvedBy?: Source & { evidence?: string };
  value: string | string[];
  evidence: string;
  evidenceStart?: number;
  targetEvidence?: {text:string;start:number};
};
type FieldReceipt = {
  field: string; status: "changed" | "already_current";
  value: Change["value"]; previous?: Change["value"];
};
export type WriteReceipt = { topic: string; changes: FieldReceipt[] };
export type TopicCard = {
  id: string;
  description: string;
  tags: string[];
  changes: Change[];
  confirmations?: Change[];
};
export type Catalog = {
  cards: TopicCard[];
  active?: string;
  pending?: { intent?: "read" | "write"; question: string; text: string; source: Source };
  boundary?: string;
  last?: Source;
};
export const compareSource = (a: Source, b: Source) =>
  a.at - b.at || a.order - b.order || a.id.localeCompare(b.id);
const same = (a: Change, b: Change) =>
  Array.isArray(a.value) && Array.isArray(b.value)
    ? JSON.stringify([...a.value].sort()) ===
      JSON.stringify([...b.value].sort())
    : a.value === b.value;
const observations = (card: TopicCard) => [...card.changes, ...(card.confirmations ?? [])];
export function versions(card: TopicCard, field: string) {
  const changes = observations(card)
    .filter((c) => c.field === field)
    .sort(compareSource);
  return changes.filter((c, i) => !i || !same(c, changes[i - 1]));
}
export const fields = (card: TopicCard) => [
  ...new Set(card.changes.map((c) => c.field)),
];
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const label = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 2000;
const labels = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 100 && v.every(label);

// Generic advice can refer to several objects of the same kind. In that
// case the active selection alone is insufficient evidence of the target.
export function routeTopicDecision(catalog: Catalog, plan: unknown, text: string): unknown {
  if (!object(plan) || catalog.pending) return plan;
  if (plan.action !== "read" && plan.action !== "dialogue" && plan.action !== "write") return plan;
  if (plan.purpose !== "advice" && !/(?:как (?:лучше|стоит|распределить)|посоветуй|how (?:best|should)|any advice)/iu.test(text)) return plan;
  const advice = plan.action === "write"
    ? (catalog.cards.some(c => c.id === plan.id) ? {action:"read", queries:[{id:plan.id}]} : {action:"dialogue"})
    : plan;
  if (catalog.cards.length < 2) return advice;
  const words = (s: string) => s.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  // Allow common inflections in task names. Only shared terms create an
  // ambiguity; a distinctive destination, tag or name selects a candidate.
  const labels = catalog.cards.map(c => words([c.description,...c.tags].join(" ")));
  let shared = false;
  for (const word of words(text).filter(w => w.length >= 3)) {
    const stem = word.length >= 5 ? word.slice(0, -1) : word;
    const matches = labels.filter(tokens => tokens.some(t => t.startsWith(stem))).length;
    if (matches === 1) return advice;
    if (matches > 1) shared = true;
  }
  if (!shared && plan.purpose !== "advice") return advice;
  const titles = catalog.cards.map(c => c.description).join(" / ");
  return {action:"clarify", intent:"read", question: /[а-яё]/iu.test(text) ? "Для какой поездки или задачи? " + titles : "Which task do you mean? " + titles};
}
// Keep the literal source if it already contains the delimiters. Otherwise
// accept exactly one matched outer quotation pair, without editing its contents.
function sourceQuote(raw: string, sources: string[]) {
  return quoteForms(raw).find(span => sources.some(s => s.includes(span)));
}

function exactQuote(raw: string, sources: string[]) {
  const span = sourceQuote(raw, sources);
  if (!span) throw Error("Missing field evidence.");
  return span;
}

export function topicWords(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(w => w.replace(/(?:ная|ной|ную|ные|ных)$/u, "н").replace(/(?:ами|ями|ах|ях|ом|ам|ям|е|а|у|ы|и|о|ю|я)$/u,""))
    .filter(w => w.length >= 3);
}

// The reply, checked against the catalog as it existed before the write,
// must independently identify the card proposed by the extractor.
export function clarificationSelects(cards: TopicCard[], id: string, reply: string) {
  if (/[?？]/u.test(reply) || /(?:^|[^\p{L}])(?:not|except|or|maybe|не|кроме|или|возможно)(?!\p{L})/iu.test(reply)) return false;
  const words = new Set(topicWords(reply));
  const owners = new Set<string>();
  const labels = cards.map(c => ({id: c.id, terms: topicWords([c.description, ...c.tags].join(" "))}));
  for (const word of words) {
    const matches = labels.filter(c => c.terms.includes(word));
    if (matches.length === 1) owners.add(matches[0].id);
  }
  return owners.size === 1 && owners.has(id);
}

function clarifiedEvidence(raw: unknown, original: string, reply: string) {
  if (object(raw) && Object.keys(raw).length === 2 && label(raw.instruction) && label(raw.clarification)) {
    return {instruction: exactQuote(raw.instruction, [original]), clarification: exactQuote(raw.clarification, [reply])};
  }
  if (!label(raw)) throw Error("Invalid field evidence.");
  // The original single-quote contract remains valid. The reply supplies
  // a separate, independently checked target citation.
  const single = sourceQuote(raw, [original]);
  if (single) return {instruction: single, clarification: reply};
  if (!raw.includes("; ")) throw Error("Missing field evidence.");
  // Accept the observed two-message presentation only when both complete
  // utterances are copied, optionally omitting their terminal punctuation.
  const parts = raw.split("; ");
  if (parts.length !== 2) throw Error("Invalid two-message evidence.");
  const complete = (quote: string, message: string) => {
    const span = exactQuote(quote, [message]);
    if (span !== message && span !== message.replace(/[.!?]+$/u, ""))
      throw Error("Incomplete two-message evidence.");
    return span;
  };
  return {instruction: complete(parts[0], original), clarification: complete(parts[1], reply)};
}

export function applyTopic(catalog: Catalog, plan: unknown, source: Source, text: string, receipts?: WriteReceipt[], repaired = false): unknown {
  if (!object(plan) || plan.action !== "write") return applySingle(catalog, plan, source, text);
  const draft = structuredClone(catalog);
  const written: WriteReceipt[] = [];
  let view: unknown;
  if ("updates" in plan) {
    if (Object.keys(plan).some(k => !["action","updates"].includes(k)) || catalog.pending ||
        !Array.isArray(plan.updates) || plan.updates.length < 2 || plan.updates.length > catalog.cards.length)
      throw Error("Invalid multi-topic write.");
    const labels = catalog.cards.map(c => ({id:c.id, words:new Set(topicWords([c.description,...c.tags].join(" ")))}));
    const seen = new Set();
    view = plan.updates.map(update => {
      if (!object(update) || !labels.some(c => c.id === update.id) || seen.has(update.id) ||
          Object.keys(update).some(k=>!["id","description","tags","changes","targetEvidence"].includes(k)) ||
          !Array.isArray(update.changes) || !update.changes.length)
        throw Error("Invalid multi-topic target.");
      seen.add(update.id);
      for (const change of update.changes) {
        if (!object(change) || !label(change.evidence)) throw Error("Missing field evidence.");
        const owners = new Set<string>();
        for (const word of topicWords(locateEvidence(label(update.targetEvidence) ? update.targetEvidence : change.evidence,text).text)) {
          const matches = labels.filter(c => c.words.has(word));
          if (matches.length === 1) owners.add(matches[0].id);
        }
        if (owners.size !== 1 || !owners.has(String(update.id)))
          throw Error("Each multi-topic change needs a source clause identifying its target.");
      }
      draft.last = catalog.last;
      return applySingle(draft,{...update,action:"write"},source,text,written,repaired);
    });
    // A batch identifies multiple cards and does not select a new active task.
    draft.active = catalog.active;
  } else {
    view = applySingle(draft,plan,source,text,written,repaired);
  }
  Object.assign(catalog,draft);
  if (!draft.pending) delete catalog.pending;
  receipts?.push(...written);
  return view;
}

function applySingle(catalog: Catalog, plan: unknown, source: Source, text: string, receipts?: WriteReceipt[], repaired = false): unknown {
  if (!object(plan)) throw Error("Invalid topic decision.");
  const find = (id: unknown) => {
    const card = catalog.cards.find((c) => c.id === id);
    if (!card) throw Error("Unknown topic card.");
    return card;
  };
  const newer = !catalog.last || compareSource(source, catalog.last) > 0;
  const select = (id: string) => {
    if (newer) {
      catalog.active = id;
    }
  };
  let view: unknown;
  if (plan.action === "clarify" && label(plan.question)) {
    if (newer)
      catalog.pending = {
        intent: catalog.pending?.intent ?? (plan.intent === "read" || plan.intent === "write" ? plan.intent : undefined),
        question: plan.question,
        text: catalog.pending?.text ?? text,
        source: catalog.pending?.source ?? source,
      };
    view = { ask: plan.question };
  } else if (
    plan.action === "write" &&
    label(plan.description) &&
    labels(plan.tags) &&
    Array.isArray(plan.changes)
  ) {
    if (catalog.pending?.intent === "read") {
      // A destination reply to an advice question selects the card. The
      // assistant's suggestions cannot become confirmed assignments.
      const selected = find(plan.id);
      return applyTopic(catalog, {action:"read", queries:[{id:selected.id}]}, source, text);
    }
    const id = plan.id === "new" ? source.id : plan.id;
    const pending = catalog.pending;
    const resolvedCard = catalog.cards.find(c => observations(c).some(ch => ch.resolvedBy?.id === source.id));
    if ((pending || resolvedCard) && (
      typeof id !== "string" || !clarificationSelects(catalog.cards, id, text) ||
      (resolvedCard && resolvedCard.id !== id) || !plan.changes.length ||
      (pending && compareSource(source, pending.source) <= 0)
    )) throw Error("Clarification does not identify the selected topic.");
    let card = catalog.cards.find((c) => c.id === id);
    if (!card) {
      if (plan.id !== "new") throw Error("Unknown topic card.");
      card = {
        id: source.id,
        description: plan.description,
        tags: plan.tags,
        changes: [],
      };
      catalog.cards.push(card);
    }
    const receipt: FieldReceipt[] = [];
    let resolvedPending = false;
    const direct = !pending && !resolvedCard;
    const targetSpan=direct && label(plan.targetEvidence) ? locateEvidence(plan.targetEvidence,text) : undefined;
    const spansByChange = direct ? plan.changes.map(change => {
      if (!object(change) || !label(change.evidence)) throw new GroundingError("Missing field evidence.");
      return locateEvidence(change.evidence, text);
    }) : [];
    const strict = repaired || spansByChange.some(span => span.recovered);
    for (const [index, change] of plan.changes.entries()) {
      if (
        !object(change) ||
        !label(change.field) ||
        !(label(change.value) || labels(change.value))
      )
        throw Error("Invalid field change.");
      const entries = observations(card);
      const replay = entries.find(
        (c) => c.resolvedBy?.id === source.id && c.field === change.field,
      );
      if (resolvedCard && !replay) throw Error("Conflicting clarification replay.");
      const original = pending?.text ?? replay?.evidence;
      const spans = original !== undefined ? clarifiedEvidence(change.evidence, original, text) : undefined;
      if (spans && !clarificationSelects(catalog.cards, card.id, spans.clarification))
        throw Error("Clarification evidence does not identify the selected topic.");
      if (!spans && !label(change.evidence)) throw Error("Invalid field evidence.");
      const span = spansByChange[index];
      const evidence = spans?.instruction ?? span.text;
      const origin = pending?.source ?? replay ?? source;
      if (pending) resolvedPending = true;
      const previous = entries.find(c => c.id === origin.id && c.field === change.field);
      if (previous && (!same(previous, {...previous, value:change.value}) || previous.evidence !== evidence ||
          (previous.resolvedBy?.evidence && previous.resolvedBy.evidence !== spans?.clarification)))
        throw Error("Conflicting source replay.");
      if (receipt.some(entry => entry.field === change.field)) continue;
      const prior = versions(card, change.field).filter(c => compareSource(c,origin) < 0).at(-1);
      if (span) checkFieldClaim(span, text, {field: change.field, value: change.value}, card, catalog.cards, strict, catalog.active, prior?.value);
      const day = targetSpan && /^(?:date|deadline|дата|срок)$/iu.test(change.field) && typeof change.value==="string" ? canonicalDay(change.value) : undefined;
      const confirmed = prior && (same(prior, {...prior,value:change.value}) ||
        (day && typeof prior.value==="string" && canonicalDay(prior.value)===day));
      const effectiveValue = confirmed ? prior.value : change.value;
      receipt.push({field: change.field, status: confirmed ? "already_current" : "changed", previous: prior?.value, value: effectiveValue});
      if (previous) continue;
      const collection = confirmed ? (card.confirmations ??= []) : card.changes;
      collection.push({
        ...origin,
        ...(spans ? { resolvedBy: {...source, evidence: spans.clarification} } : {}),
        field: change.field,
        value: effectiveValue,
        evidence,
        ...(span ? {evidenceStart: span.start} : {}),
        ...(targetSpan ? {targetEvidence:{text:targetSpan.text,start:targetSpan.start}} : {}),
      });
    }
    if (newer) {
      if (resolvedPending) delete catalog.pending;
      if (!pending) {
        card.description = plan.description;
        card.tags = [...new Set(plan.tags)];
      }
    }
    select(card.id);
    if (receipt.length) receipts?.push({topic: card.description, changes: receipt});
    view = {...currentCard(card), recordedChanges: receipt};
  } else if (
    plan.action === "read" &&
    Array.isArray(plan.queries) &&
    plan.queries.length
  ) {
    view = plan.queries.map((q) => {
      if (!object(q)) throw Error("Invalid lookup.");
      const card = find(q.id);
      if (q.field === undefined) return currentCard(card);
      if (!label(q.field)) throw Error("Invalid field.");
      const history = versions(card, q.field);
      if (q.history === true)
        return {
          topic: card.description,
          field: q.field,
          versions: history.map((c, i) => ({
            version: i + 1,
            at: c.at,
            order: c.order,
            value: c.value,
            evidence: c.evidence,
          })),
        };
      const index = (i: unknown) => {
        if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 1)
          throw Error("Invalid version.");
        return i - 1;
      };
      let hit = history.at(-1);
      if (q.version !== undefined) hit = history[index(q.version)];
      if (q.time !== undefined) {
        if (
          typeof q.time !== "string" ||
          !q.time.endsWith("Z") ||
          !Number.isFinite(Date.parse(q.time))
        )
          throw Error("Invalid UTC time.");
        hit = history.filter((c) => c.at <= Date.parse(String(q.time))).at(-1);
      }
      if (q.at !== undefined) {
        if (!object(q.at) || !label(q.at.field))
          throw Error("Invalid time reference.");
        const events = versions(card, q.at.field);
        const anchorIndex = index(q.at.version);
        const anchor = events[anchorIndex];
        hit =
          anchor && history.filter((c) => compareSource(c, anchor) <= 0).at(-1);
        return {topic: card.description, field: q.field, value: hit?.value ?? null,
          event: anchor ? {...anchor, version: anchorIndex + 1, previous: events[anchorIndex-1]?.value} : null,
          effectiveRecord: hit ?? null};
      }
      return {
        topic: card.description,
        field: q.field,
        value: hit?.value ?? null,
      };
    });
    const targets = new Set(plan.queries.map(q => q.id));
    if (targets.size === 1) {
      select(plan.queries[0].id);
      if (newer && catalog.pending && catalog.pending.intent !== "write") {
        view = {originalQuestion: catalog.pending.text, selectedRecords: view};
        delete catalog.pending;
      }
    }
  } else throw Error("Invalid topic decision.");
  if (newer) catalog.last = source;
  return view;
}
export function currentCard(card: TopicCard) {
  return {
    id: card.id,
    description: card.description,
    tags: card.tags,
    fields: Object.fromEntries(
      fields(card).map((f) => [f, versions(card, f).at(-1)?.value]),
    ),
  };
}

// Shared tags rank candidates; identity always comes from the stable card ID.
export function rankedCards(catalog: Catalog, text: string) {
  const words = text.toLocaleLowerCase().normalize("NFKC");
  function score(c: TopicCard) {
    return (
      c.tags.reduce(
        (n, t) => n + Number(words.includes(t.toLocaleLowerCase())),
        0,
      ) +
      Number(words.includes(c.description.toLocaleLowerCase())) * 2
    );
  }
  return [...catalog.cards].sort((a, b) => score(b) - score(a));
}
