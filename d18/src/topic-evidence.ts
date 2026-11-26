// Offsets use JavaScript's UTF-16 indices into the unchanged user message.
export type EvidenceSpan = { text: string; start: number; recovered: boolean };
export class GroundingError extends Error {}

const pairs: Record<string, string> = {
  "«": "»",
  "“": "”",
  "‘": "’",
  '"': '"',
  "'": "'",
};
export function quoteForms(raw: string) {
  const inner = raw.slice(1, -1);
  return pairs[raw[0]] === raw.at(-1) && inner.trim() ? [raw, inner] : [raw];
}

export function locateEvidence(raw: string, source: string): EvidenceSpan {
  const forms = quoteForms(raw);
  for (const quote of forms) {
    const start = source.indexOf(quote);
    if (start < 0) continue;
    if (source.indexOf(quote, start + 1) >= 0)
      throw new GroundingError("Ambiguous field evidence.");
    return { text: quote, start, recovered: false };
  }
  for (const quote of forms) {
    const pattern = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let found: EvidenceSpan | undefined;
    // Lookahead also detects overlapping occurrences. Never transform the
    // whole message before computing offsets (Unicode folding can change length).
    for (const match of source.matchAll(
      new RegExp("(?=(" + pattern + "))", "giu"),
    )) {
      if (match[1].toLowerCase() !== quote.toLowerCase()) continue;
      if (found) throw new GroundingError("Ambiguous field evidence.");
      found = { text: match[1], start: match.index!, recovered: true };
    }
    if (found) return found;
  }
  throw new GroundingError("Missing field evidence.");
}

const plain = (text: string) =>
  text.trim().replace(/[.!]$/u, "").trim().toLowerCase();
const discourse = /^(?:now|next|теперь|сейчас|далее)[,\s]+/iu;
const dateField = /^(?:date|deadline|дата|срок)$/iu;
const rosterField = /^(?:participants|roster|участники|состав)$/iu;
const noteField = /^(?:notes?|заметки|заметка)$/iu;
const fieldHeading =
  /^(?:date|deadline|дата|срок|participants|roster|участники|состав|notes?|заметка|заметки)$/iu;

// Month names in the two supported declaration languages, including the
// Russian genitive used with a day number. Other date prose needs a clearer citation.
const months = new Map(
  ["ru-RU", "en-US"].flatMap((locale) => {
    const format = new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    return Array.from({ length: 12 }, (_, i) => [
      format.formatToParts(Date.UTC(2000, i, 1)).find(part=>part.type==="month")!.value.toLowerCase(),
      i+1
    ] as const);
  }),
);

// Canonicalize a fully specified declaration without supplying a missing year.
export function canonicalDay(text:string) {
  const body=plain(text);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(body)) return explicitDate(body,body) ? body : undefined;
  const match=/^(?:(\d{1,2}) (\p{L}+)|(\p{L}+) (\d{1,2})),? (\d{4})(?: года)?$/u.exec(body);
  if (!match) return;
  const month=months.get(match[2] ?? match[3]);
  if (!month) return;
  const iso=match[5]+"-"+String(month).padStart(2,"0")+"-"+(match[1]??match[4]).padStart(2,"0");
  return explicitDate(iso,body) ? iso : undefined;
}

export function explicitDate(value: string, body: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (value.toLowerCase() !== body) return false;
    if (/^(?:today|tomorrow|сегодня|завтра)$/u.test(body)) return true;
    const date =
      /^(?:(\d{1,2}) ([\p{L}]+)|([\p{L}]+) (\d{1,2}))(?:,? \d{4}(?: года)?)?$/u.exec(
        body,
      );
    return (
      !!date &&
      months.has(date[2] ?? date[3]) &&
      Number(date[1] ?? date[4]) >= 1 &&
      Number(date[1] ?? date[4]) <= 31
    );
  }
  const date = new Date(value + "T00:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    return false;
  if (body === value) return true;
  return ["ru-RU", "en-US", "en-GB"].some((locale) => {
    const parts = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).formatToParts(date);
    const part = (name: string) => parts.find((p) => p.type === name)?.value;
    const text =
      locale === "en-US"
        ? part("month") + " " + part("day") + ", " + part("year")
        : part("day") + " " + part("month") + " " + part("year");
    return text.toLowerCase() === body.replace(/\s+(?:года|г)$/u, "");
  });
}

// Recognize a complete, affirmative substitution. The negative verb is part of
// this grammar, so conditionals, questions and compound alternatives cannot match.
const personName = String.raw`([\p{Lu}][\p{L}'’-]*)`;
const russianReplacement = new RegExp("^" + personName + String.raw` не (?:едет|поедет|идёт|идет)(?: ((?:на|в) [\p{L}-]+(?: [\p{L}-]+){0,3}))?,\s*вместо (?:неё|нее|него) (?:едет|поедет|идёт|идет) ` + personName + "[.!]?$", "u");
const englishReplacement = new RegExp("^[Rr]eplace " + personName + " with " + personName + "[.!]?$", "u");
export function rosterReplacement(statement: string) {
  const text = statement.trim();
  const match = russianReplacement.exec(text);
  if (match) return {outgoing:match[1], destination:match[2], incoming:match[3]};
  const english = englishReplacement.exec(text);
  if (english) return {outgoing:english[1], incoming:english[2], destination:undefined};
}

export function replacedRoster(previous: unknown, change: NonNullable<ReturnType<typeof rosterReplacement>>) {
  if (!Array.isArray(previous) || !previous.every(n=>typeof n==="string") ||
      previous.filter(n=>n===change.outgoing).length!==1 ||
      previous.some(n=>plain(n)===plain(change.incoming))) return;
  return previous.map((name:string)=>name===change.outgoing ? change.incoming : name);
}

type Claim = { field: string; value: string | string[] };
type Topic = { id: string; description: string; tags: string[] };

// Interpret only literal declarations. Unsupported paraphrases on the recovery
// path cannot authorize a write, even if a provider supplies a different quote.
export function checkFieldClaim(
  span: EvidenceSpan,
  source: string,
  claim: Claim,
  target: Topic,
  cards: Topic[],
  strict: boolean,
  active: string | undefined,
  previous?: string | string[],
) {
  const fail = () => {
    throw new GroundingError("Unsupported field evidence.");
  };
  // A comma before a roster declaration separates fields; commas within
  // a roster or a formatted calendar date remain part of that field.
  const clauses = [...source.matchAll(/(?:(?!,\s*(?:идут|едут|участвуют|participants are|attendees are)\s)[^.!?;\n])+[.!?;]?/giu)];
  const index = clauses.findIndex(
    (m) => m.index! <= span.start && span.start < m.index! + m[0].length,
  );
  if (index < 0) {
    if (strict) fail();
    return;
  }
  const clause = clauses[index][0].trim().replace(/;$/u, "");
  const statement = plain(clause).replace(discourse, "");
  const pieces = statement.split(":");
  const heading = pieces.length === 2 ? pieces[0].trim() : "";
  const body = heading ? pieces[1].trim() : statement;
  const citation = plain(span.text).replace(discourse, "");
  const whole = citation === statement || citation === body;
  if (strict && (!whole || clause.endsWith("?"))) fail();

  // A topic heading scopes the declarations that follow it, until the next
  // topic heading. Compare against pre-write metadata for existing cards.
  let owner: string | undefined;
  let topicHeading = false;
  for (const m of clauses.slice(0, index + 1)) {
    const colon = m[0].indexOf(":");
    if (colon < 0) {
      if (!strict) continue;
      const words =
        " " +
        plain(m[0])
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim() +
        " ";
      const mentioned = cards.filter((card) =>
        [card.description, ...card.tags].some((label) => {
          const name = plain(label);
          return (
            name &&
            words.includes(" " + name + " ") &&
            !cards.some(
              (other) =>
                other !== card &&
                [other.description, ...other.tags].some(
                  (v) => plain(v) === name,
                ),
            )
          );
        }),
      );
      if (mentioned.length)
        owner = mentioned.length === 1 ? mentioned[0].id : "";
      continue;
    }
    const title = plain(m[0].slice(0, colon)).replace(discourse, "");
    if (fieldHeading.test(title)) continue;
    const matches = cards.filter((c) =>
      [c.description, ...c.tags].some((t) => plain(t) === title),
    );
    owner = matches.length === 1 ? matches[0].id : "";
    topicHeading = true;
  }
  if (owner !== undefined && owner !== target.id && (strict || owner !== ""))
    fail();
  // An exact quote from the wrong field is still the wrong citation. For
  // declarations under an explicit topic heading, verify the claim even
  // when the model copied its evidence without changing capitalization.
  const declared = topicHeading && owner === target.id;
  if (strict && owner === undefined && (active !== target.id || index !== 0))
    fail();
  if (dateField.test(claim.field)) {
    const dateBody = body.replace(/^(?:date is|deadline is|дата)\s+/u, "");
    if (
      strict ||
      declared ||
      (/\d{4}/u.test(dateBody) && /^(?:\d|[a-z]+ \d)/iu.test(dateBody))
    ) {
      if (
        (heading && fieldHeading.test(heading) && !dateField.test(heading)) ||
        typeof claim.value !== "string" ||
        !explicitDate(claim.value, dateBody) ||
        (!whole && !explicitDate(claim.value, citation))
      )
        fail();
    }
  } else if (rosterField.test(claim.field)) {
    const substitution = rosterReplacement(span.text);
    if (substitution && whole) {
      const roster = replacedRoster(previous, substitution);
      if (!roster || !Array.isArray(claim.value) || roster.length !== claim.value.length ||
          !roster.every((name,i)=>claim.value[i]===name)) fail();
      return;
    }
    const listed =
      /^(?:идут|едут|участвуют|participants are|attendees are)\s+(.+)$/iu.exec(
        body,
      )?.[1];
    if (strict || declared || listed || rosterField.test(heading)) {
      if (
        (!listed && !rosterField.test(heading)) ||
        (fieldHeading.test(heading) && !rosterField.test(heading))
      )
        fail();
      const names = (listed ?? body)
        .split(/\s*,\s*|\s+(?:и|and)\s+/iu)
        .map(plain)
        .sort();
      const proposed = Array.isArray(claim.value)
        ? claim.value.map(plain).sort()
        : [];
      if (
        names.length !== proposed.length ||
        names.some((name, i) => name !== proposed[i])
      )
        fail();
    }
  } else if (noteField.test(claim.field)) {
    const values = Array.isArray(claim.value) ? claim.value : [claim.value];
    const prior = Array.isArray(previous)
      ? previous
      : previous === undefined
        ? []
        : [previous];
    if (
      strict ||
      declared ||
      (whole &&
        (noteField.test(heading) || (!prior.length && values.length === 1)))
    ) {
      if (
        !values.length ||
        values.some(
          (v) =>
            !prior.includes(v) && plain(v) !== body && plain(v) !== statement,
        )
      )
        fail();
      if (
        strict &&
        (prior.some((v) => !values.includes(v)) ||
          !values.some((v) => plain(v) === body || plain(v) === statement))
      )
        fail();
    }
  } else if (
    strict &&
    (heading !== plain(claim.field) ||
      typeof claim.value !== "string" ||
      plain(claim.value) !== body)
  )
    fail();
}
