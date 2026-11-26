import { type MemoryProposal } from "./memory-proposal.ts";
import {
  canonicalDay,
  explicitDate,
  locateEvidence,
  rosterReplacement,
  replacedRoster,
} from "./topic-evidence.ts";
import {
  clarificationSelects,
  topicWords,
  versions,
  type Catalog,
  type Source,
  compareSource,
} from "./topic-cards.ts";

const clean = (s: string) =>
  s
    .trim()
    .replace(/[.!;]+$/u, "")
    .trim()
    .toLowerCase();
const ambiguous = () => {
  throw Error("The memory target is ambiguous. Specify the topic.");
};
const unsupported = () => {
  throw Error("Unsupported field evidence.");
};
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const wrap = (s: string) => " " + words(s).join(" ") + " ";
const scalarLabels: Record<string, string[]> = {
  status: ["статус", "состояние"],
  requirement: ["требование", "условие"],
  approach: ["подход", "способ", "решение"],
};
function fieldLabel(field: string, clause: string) {
  return [field, ...(scalarLabels[field.toLowerCase()] ?? [])].some((label) =>
    wrap(clause).includes(wrap(label)),
  );
}
const conditional =
  /(?:^|[^\p{L}])(?:не|нет|если|возможно|может быть|отмен[а-яё]*|вместо|not|never|if|maybe|instead of|cancelled)(?!\p{L})|[?？]/iu;

// Ground identity in the user's title, including qualifiers a short model quote
// may omit. Generic category words can narrow candidates but cannot select one.
const genericTerms = new Set(
  topicWords(
    "trip trips holiday vacation plan planning project task поездка путешествие отдых планирование проект задача the for with про для",
  ),
);
const planningLead =
  /^(?:(?:(?:let['’]s|let us|please|I want to|I['’]d like to)\s+)?(?:start planning|plan|organize|create)|(?:давай(?:те)?\s+)?(?:спланируем|запланируем|начнём планировать|начнем планировать|создадим))\s+/iu;
const distinctLabel =
  /^(?:(?:a|an|the)\s+)?(?:(?:separate|another|distinct|отдельн[а-яё]*|друг(?:ая|ую|ой|ое))\s+|(?:new|нов[а-яё]*)\s+(?=trip|plan|project|task|topic|journey|поездк|проект|задач|тем|путешеств))/iu;
const withoutArticle = (s: string) => clean(s).replace(/^(?:a|an|the)\s+/u, "");

function creationReference(
  message: string,
  mention: ReturnType<typeof locateEvidence>,
) {
  const start = message.slice(0, mention.start).search(/[^.!?;\n]*$/u);
  const clause = message
    .slice(start)
    .split(/[.!?;\n]/u)[0]
    .trim();
  const heading = clause.split(":")[0].trim();
  const named = heading.includes(mention.text.trim().replace(/[.!?]$/u, ""))
    ? heading
    : mention.text;
  return clean(named.replace(planningLead, ""));
}

function resolveCreation(catalog: Catalog, reference: string) {
  if (distinctLabel.test(reference)) return { kind: "new" } as const;
  const terms = topicWords(reference);
  const labels = catalog.cards.map((card) => ({
    card,
    terms: new Set(topicWords([card.description, ...card.tags].join(" "))),
  }));
  const specific = terms.filter((t) => !genericTerms.has(t));
  const candidates = labels.filter((c) =>
    (specific.length ? specific : terms).some((t) => c.terms.has(t)),
  );
  if (!candidates.length) return { kind: "new" } as const;
  const matches = candidates.filter(
    (c) => specific.length && specific.every((t) => c.terms.has(t)),
  );
  if (
    matches.length === 1 &&
    clarificationSelects(catalog.cards, matches[0].card.id, reference)
  )
    return { kind: "existing", card: matches[0].card } as const;
  return { kind: "clarify", cards: candidates.map((c) => c.card) } as const;
}

function isPlanningLabel(clause: string, mention: string) {
  const statement = clean(clause);
  if (
    !planningLead.test(statement) ||
    /[:,;!?]|\s(?:and then|so that|потом|чтобы)\s/iu.test(statement)
  )
    return false;
  const label = withoutArticle(statement.replace(planningLead, "")).replace(
    distinctLabel,
    "",
  );
  const name = withoutArticle(clean(mention).replace(planningLead, "")).replace(
    distinctLabel,
    "",
  );
  // The citation can name just the destination in a longer planning request.
  // A second assertion needs its own evidence, not the planning directive.
  return (
    label === name ||
    (label.includes(name) &&
      !/[0-9]|\s(?:and|must|will|is|are|и|нужно|надо|обязательно|берёт|будет)\s/iu.test(
        label,
      ))
  );
}

type ProposalTopic = MemoryProposal["topic"];
type Assignment = Extract<
  Extract<ProposalTopic, { kind: "write" }>["updates"][number]["edits"][number],
  { kind: "assign" }
>;

function assignmentObject(edit: Assignment, statement: string) {
  const actor = clean(edit.person),
    text = clean(statement),
    item = clean(edit.item);
  for (const verb of [
    "берёт",
    "берет",
    "несёт",
    "несет",
    "takes",
    "brings",
    "will bring",
  ]) {
    const prefix = actor + " " + verb + " ";
    if (!text.startsWith(prefix)) continue;
    const object = text.slice(prefix.length);
    if (object && [object, verb + " " + object, text].includes(item))
      return object;
  }
}

// Compare the substance of repairs. A nonexistent pending source can only be
// corrected to current if its exact quote already exists there. Execution
// still validates the original wire source independently on every attempt.
export function repairClaims(
  topic: Extract<ProposalTopic, { kind: "write" }>,
  catalog: Catalog,
  message: string,
) {
  const citation = (span: Assignment["evidence"]) => {
    if (
      span.source === "pending" &&
      !catalog.pending &&
      message.includes(span.quote)
    )
      return { ...span, source: "current" as const };
    return span;
  };
  const comparable = resolveProposalTarget(
    {
      ...topic,
      updates: topic.updates.map(({ target, edits }) => ({
        target: { ...target, mention: citation(target.mention) },
        edits: edits.map((edit) =>
          edit.kind === "assign"
            ? {
                ...edit,
                item: assignmentObject(edit, edit.evidence.quote) ?? edit.item,
                evidence: citation(edit.evidence),
              }
            : { ...edit, evidence: citation(edit.evidence) },
        ),
      })),
    },
    catalog,
    message,
  );
  // An ambiguous proposal cannot gain equivalence through its clarification text.
  const write = comparable.kind === "write" ? comparable : topic;
  // An existing target is identified by its card ID. Its mention is proof
  // checked anew by the mapper, not part of the edit being authorized.
  // Compare edit sources as before: a clarification cannot change authorship.
  return JSON.stringify(write, (key, value) => {
    if (key === "target" && value.kind === "existing")
      return { kind: "existing", card: value.card };
    if (key === "quote") return undefined;
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value;
  });
}

// Resolve before comparing repair claims so a corrected wire handle for the
// same verified card does not look like a request to edit a different card.
export function resolveProposalTarget(
  topic: MemoryProposal["topic"],
  catalog: Catalog,
  message: string,
): MemoryProposal["topic"] {
  if (topic.kind !== "write" || topic.updates.length !== 1) return topic;
  const { target, edits } = topic.updates[0];
  if (target.kind !== "new" || target.mention.source !== "current")
    return topic;
  let span;
  try {
    span = locateEvidence(target.mention.quote, message);
  } catch {
    return topic;
  } // The mapper will reject the original invalid citation.
  const resolution = resolveCreation(catalog, creationReference(message, span));
  if (resolution.kind === "clarify") {
    const titles = resolution.cards.map((c) => c.description).join(" / ");
    return {
      kind: "clarify",
      intent: "write",
      question:
        (/[а-яё]/iu.test(message)
          ? "Какую задачу вы имеете в виду? "
          : "Which task do you mean? ") + titles,
    };
  }
  if (resolution.kind === "existing") {
    return {
      kind: "write",
      updates: [
        {
          target: {
            kind: "existing",
            card: resolution.card.id,
            mention: target.mention,
          },
          edits,
        },
      ],
    };
  }
  return topic;
}

// A text exercise has an explicit read-only instruction and a supplied
// passage. A colon delimits the passage; after a full stop require quotation
// or a verbatim specimen. A second independent instruction is not a passage.
function isTextExercise(message: string) {
  const match = /^(?:please\s+)?(?:read|summari[sz]e|translate|proofread|перескажи|прочти|прочитай|переведи)\s+((?:(?:the|this|following|sample|этот|следующий|данный)\s+)*(?:text|passage|excerpt|sample|текст|отрывок|образец)(?: текста)?)([.:])\s*([\s\S]+)$/iu.exec(message.trim());
  if (!match) return false;
  const [, object, separator, passage] = match;
  if (/^["«“]/u.test(passage)) return /^(?:"[^"]+"|«[^»]+»|“[^”]+”)[.!]?$/u.test(passage);
  if (separator === ":" && !/[.!?;\n].*\S/su.test(passage)) return true;
  const sentences = passage.split(/[.!?]+/u).map(s => s.trim()).filter(Boolean);
  return sentences.length > 0 && sentences.every(s => s.toLowerCase() === object.toLowerCase());
}

export function mapMemoryTopic(
  topic: MemoryProposal["topic"],
  catalog: Catalog,
  message: string,
  source: Source,
) {
  if (
    catalog.pending?.intent === "read" &&
    (topic.kind === "dialogue" || topic.kind === "write")
  ) {
    const selected = catalog.cards.filter((c) =>
      clarificationSelects(catalog.cards, c.id, message),
    );
    if (selected.length === 1)
      return { action: "read", queries: [{ id: selected[0].id }] };
  }
  if (
    catalog.pending?.intent === "write" &&
    (topic.kind === "dialogue" || topic.kind === "read") &&
    catalog.cards.some((c) =>
      clarificationSelects(catalog.cards, c.id, message),
    )
  ) {
    throw Error("A resolved pending update requires a grounded write.");
  }
  if (topic.kind === "abstain") {
    if (!catalog.pending && isTextExercise(message)) return { action: "dialogue", textOnly: true };
    throw Error("The proposed memory change could not be grounded.");
  }
  if (topic.kind === "read") {
    if (!topic.queries.length) throw Error("Missing memory query.");
    return {
      action: "read",
      purpose: topic.purpose,
      queries: topic.queries.map(({ card, field, selector }) => {
        if (
          catalog.pending &&
          !clarificationSelects(catalog.cards, card, message)
        )
          ambiguous();
        if (!field && selector.kind !== "current")
          throw Error("Historical lookup requires a field.");
        const selection =
          selector.kind === "at_change"
            ? { at: { field: selector.field, version: selector.version } }
            : selector.kind === "time"
              ? { time: selector.utc }
              : selector.kind === "version"
                ? { version: selector.number }
                : selector.kind === "history"
                  ? { history: true }
                  : {};
        return { id: card, ...(field ? { field } : {}), ...selection };
      }),
    };
  }
  if (topic.kind !== "write") return { ...topic, action: topic.kind };
  const pending = catalog.pending;
  if (pending?.intent === "read" || !topic.updates.length) return ambiguous();
  const multi = topic.updates.length > 1;
  const targets = new Set<string>();
  // Every explicitly named candidate in a multi-topic instruction needs
  // a disposition. A repaired response cannot silently save a prefix.
  const mentionedCards = new Set<string>();
  for (const token of topicWords(message)) {
    const matches = catalog.cards.filter((c) =>
      topicWords([c.description, ...c.tags].join(" ")).includes(token),
    );
    if (matches.length === 1) mentionedCards.add(matches[0].id);
  }
  const updates = topic.updates.map(({ target, edits }) => {
    if (target.mention.source !== "current") return ambiguous();
    const mention = locateEvidence(target.mention.quote, message);
    const card =
      target.kind === "existing"
        ? catalog.cards.find((c) => c.id === target.card)
        : undefined;
    if (target.kind === "existing" && !card) return ambiguous();
    const id = card?.id ?? "new";
    if (targets.has(id) || (multi && (!card || !edits.length || pending)))
      return ambiguous();
    targets.add(id);
    let description =
      target.kind === "new" ? target.description : card!.description;
    let tags = target.kind === "new" ? target.tags : card!.tags;
    const original = pending?.text ?? message;
    const substitution = edits.length === 1 && edits[0].kind === "set_roster"
      ? rosterReplacement(locateEvidence(edits[0].evidence.quote, original).text) : undefined;
    if (substitution?.destination) {
      const destination = resolveCreation(catalog, substitution.destination);
      if (destination.kind !== "existing" || destination.card.id !== id) return ambiguous();
    }
    const explicit =
      card && (clarificationSelects(catalog.cards, id, mention.text) ||
        (!!substitution?.destination && mention.text.includes(substitution.destination)));
    if (
      card &&
      !explicit &&
      (multi ||
        pending ||
        catalog.active !== id ||
        catalog.cards.some((c) =>
          clarificationSelects(catalog.cards, c.id, message),
        ))
    )
      return ambiguous();
    if (
      !card &&
      (pending ||
        !topicWords(description).some((w) =>
          topicWords(mention.text).includes(w),
        ))
    )
      return ambiguous();
    const origin = pending?.source ?? source;
    const clauses = [...original.matchAll(/[^.;!?\n]+[.;!?]?/gu)];
    const scopeCards = card
      ? catalog.cards
      : [...catalog.cards, { id, description, tags, changes: [] }];
    const owners = (text: string) => {
      const found = new Set<string>();
      for (const token of topicWords(text)) {
        const matching = scopeCards.filter((c) =>
          topicWords([c.description, ...c.tags].join(" ")).includes(token),
        );
        if (matching.length === 1) found.add(matching[0].id);
      }
      return found;
    };
    const changes = new Map<
      string,
      {
        field: string;
        value: string | string[];
        evidence: string | { instruction: string; clarification: string };
      }
    >();
    let redundantWithdrawal: {person:string; evidence:string} | undefined;
    for (const edit of edits) {
      if (edit.evidence.source !== (pending ? "pending" : "current"))
        return unsupported();
      let span = locateEvidence(edit.evidence.quote, original);
      // A full list may be followed by a corroborating withdrawal. Use the
      // declaration as its citation only after checking both original sentences.
      if (edit.kind === "set_roster") {
        const first = clauses.findIndex(c=>c.index! + c[0].length > span.start);
        const next = clauses[first+1];
        const departed = next?.[0].trim().match(/^([\p{Lu}][\p{L}'’-]*) не (?:едет|поедет|идёт|идет)[.!]?$/u);
        if (first >= 0 && departed && !substitution) {
          const declaration = clauses[first][0].trim();
          const alsoCited = span.text === original.slice(clauses[first].index!,next.index!+next[0].length).trim();
          if (edit.names.some(n=>clean(n)===clean(departed[1]))) return unsupported();
          if (alsoCited || clean(span.text)===clean(declaration)) {
            redundantWithdrawal = {person:departed[1],evidence:next[0].trim()};
            if (alsoCited) span = locateEvidence(declaration, original);
          }
        }
      }
      if (edit.kind==="withdraw" && redundantWithdrawal?.person===edit.person &&
          span.text===redundantWithdrawal.evidence && changes.has("participants")) continue;
      const clause = clauses.find(
        (c) =>
          c.index! <= span.start &&
          span.start + span.text.length <= c.index! + c[0].length,
      );
      if (!clause) return unsupported();
      if (
        multi &&
        !(
          clause.index! <= mention.start &&
          mention.start + mention.text.length <=
            clause.index! + clause[0].length
        )
      )
        return ambiguous();
      if (!pending) {
        // Carry an explicit topic over subsequent sentences, stopping at the
        // next named topic. Never borrow a fact from a neighbouring trip.
        let owner: Set<string> | undefined;
        for (const part of clauses) {
          const named = owners(part[0]);
          if (named.size) owner = named;
          else if (
            /^[^:]+:/u.test(part[0]) &&
            !fieldLabel(
              edit.kind === "set" ? edit.field : "participants",
              part[0].split(":")[0],
            )
          )
            owner = undefined;
          if (part === clause) break;
        }
        if (owner && (owner.size !== 1 || !owner.has(id))) return ambiguous();
        if (
          !owner &&
          clause[0].includes(":") &&
          !clause[0].includes(mention.text) &&
          !fieldLabel(
            edit.kind === "set" ? edit.field : "participants",
            clause[0].split(":")[0],
          )
        )
          return ambiguous();
        if (!owner && (multi || (!card && !clause[0].includes(mention.text))))
          return ambiguous();
      }
      const text = clean(span.text);
      const field =
        edit.kind === "set"
          ? edit.field
          : edit.kind === "set_roster" || edit.kind === "withdraw"
            ? "participants"
            : "notes";
      if (
        !pending &&
        edit.kind === "append_note" &&
        isPlanningLabel(clause[0], mention.text) &&
        clause[0].includes(span.text)
      )
        continue;
      if (changes.has(field))
        throw Error(
          "Several edits to the same field need one grounded declaration.",
        );
      const prior =
        card &&
        versions(card, field)
          .filter((v) => compareSource(v, origin) < 0)
          .at(-1)?.value;
      let value: string | string[];
      if (edit.kind !== "withdraw" && !substitution && conditional.test(clause[0]))
        return unsupported();
      if (edit.kind === "set" && ["description", "tag"].includes(field)) {
        if (
          !card ||
          !explicit ||
          pending ||
          multi ||
          clean(edit.value) !== text
        )
          return unsupported();
        const directive =
          field === "description"
            ? /(?:rename|description|назов[иё]|переимен|описание)/iu
            : /(?:tag|тег|метк)/iu;
        if (!directive.test(clause[0])) return unsupported();
        if (field === "description") description = span.text;
        else tags = [...new Set([...tags, span.text])];
        continue;
      }
      if (edit.kind === "set") {
        value = edit.value;
        if (/^(?:participants|roster|notes?|участники|заметки)$/iu.test(field))
          return unsupported();
        if (/^(?:date|deadline|дата|срок)$/iu.test(field)) {
          const datePattern =
            /\d{4}-\d{2}-\d{2}|\d{1,2}\s+\p{L}+\s+\d{4}(?:\s+года)?|\p{L}+\s+\d{1,2},?\s+\d{4}/giu;
          const dateText = text.match(datePattern) ?? [text];
          const datesInClause = clause[0].match(datePattern) ?? [];
          if (/\d{4}/u.test(dateText[0])) {
            const day = canonicalDay(dateText[0]);
            if (!day) return unsupported();
            value = day;
          }
          if (
            datesInClause.length === 1 &&
            !explicitDate(edit.value, clean(datesInClause[0]))
          )
            return unsupported();
          if (datesInClause.length > 1) {
            const destination = clause[0].match(
              /(?:\sна|\sto)\s+([^,;.!?]+)[.!]?$/iu,
            )?.[1];
            if (
              datesInClause.length !== 2 ||
              !destination ||
              !explicitDate(edit.value, clean(destination))
            )
              return unsupported();
          }
          if (
            dateText.length !== 1 ||
            !explicitDate(edit.value, clean(dateText[0]))
          )
            return unsupported();
        } else if (
          !fieldLabel(field, clause[0]) ||
          (clean(edit.value) !== text &&
            !text.endsWith(": " + clean(edit.value)) &&
            !text.endsWith(" is " + clean(edit.value)))
        )
          return unsupported();
      } else if (edit.kind === "set_roster" && substitution) {
        if (!card || clean(span.text)!==clean(clause[0])) return unsupported();
        if (!pending && !substitution.destination &&
            catalog.cards.filter(c=> {
              const roster=versions(c,field).filter(v=>compareSource(v,origin)<0).at(-1)?.value;
              return Array.isArray(roster) && roster.includes(substitution.outgoing);
            }).length!==1 && !explicit) return ambiguous();
        const roster = replacedRoster(prior, substitution);
        if (!roster || roster.length!==edit.names.length ||
            !roster.every((n,i)=>n===edit.names[i])) return unsupported();
        value = roster;
      } else if (edit.kind === "set_roster") {
        const declaration = clean(clause[0]).match(
          /(?:^|[:,]\s*|\s)(?:идут|едут|участники|состав|участвуют|participants(?: are)?|attendees are|roster)\s*:?\s+(.+)$/iu,
        );
        const names = declaration?.[1]
          .split(/\s*,\s*|\s+(?:и|and)\s+/iu)
          .map(clean);
        if (
          !names ||
          !names.length ||
          names.length !== edit.names.length ||
          new Set(names).size !== names.length ||
          !edit.names.every(
            (name, i) => clean(name) === names[i] && text.includes(names[i]),
          )
        )
          return unsupported();
        value = edit.names;
      } else if (edit.kind === "withdraw") {
        const escaped = edit.person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const withdrawal = new RegExp(
          "^(?:" +
            escaped +
            ")\\s+(?:не (?:сможет (?:поехать|прийти)|поедет|едет)|cannot (?:come|attend)|can't come|withdrew)$",
          "iu",
        );
        if (
          !withdrawal.test(text) ||
          !Array.isArray(prior) ||
          !prior.includes(edit.person) ||
          clean(clause[0]) !== text
        )
          return unsupported();
        if (
          !pending &&
          !explicit &&
          catalog.cards.filter((c) => {
            const roster = versions(c, field).at(-1)?.value;
            return Array.isArray(roster) && roster.includes(edit.person);
          }).length > 1
        )
          return ambiguous();
        value = prior.filter((name) => name !== edit.person);
      } else {
        if (edit.kind === "assign") {
          const declaration = clean(clause[0]).split(":").at(-1)!.trim();
          if (declaration !== text) return unsupported();
          if (!assignmentObject(edit, span.text)) return unsupported();
        }
        const old = Array.isArray(prior) ? prior : prior ? [prior] : [];
        value = old.includes(span.text) ? old : [...old, span.text];
      }
      changes.set(field, {
        field,
        value,
        evidence: pending
          ? { instruction: span.text, clarification: mention.text }
          : span.text,
      });
    }
    return {
      id,
      description,
      tags,
      changes: [...changes.values()],
      targetEvidence: mention.text,
    };
  });
  if (
    mentionedCards.size > 1 &&
    [...mentionedCards].some((card) => !targets.has(card))
  )
    return ambiguous();
  return multi
    ? { action: "write", updates }
    : { action: "write", ...updates[0] };
}
