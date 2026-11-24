import type { MemoryGroup } from "./session-memory.ts";
import { topicWords, type TopicCard } from "./topic-cards.ts";

// Only an explicitly conversation-scoped instruction reserves a literal in the
// summary. General requests to remember a preference or update a task still
// use normal memory extraction.
const directive =
  /^(?:(?:для (?:рассказа|истории|разговора|диалога)[, ]+)?запомни(?:те)?(?: (?:для (?:рассказа|истории|разговора|диалога)|(?:эту |одну )?(?:деталь|подробность)(?: разговора)?))?|(?:for (?:the |our )?(?:story|conversation|dialogue)[, ]+)?remember(?: (?:for (?:the |our )?(?:story|conversation|dialogue)|(?:this |one )?(?:dialogue |story |conversation )?detail))?)\s*[:,—]\s*(.+)$/isu;
export function dialogueDetail(text: string) {
  const match = directive.exec(text.trim());
  if (!match) return;
  const detail = match[1].trim();
  const prefix = match[0].slice(0, match[0].length - match[1].length);
  if (
    /деталь|подробность|рассказ|истори|разговор|диалог|detail|story|conversation|dialogue/iu.test(
      prefix,
    ) ||
    /(?:не для плана|не записывай в карточку|not for the plan|keep (?:it|this) out of the card)/iu.test(
      detail,
    )
  )
    return detail;
}

function userDetails(groups: readonly MemoryGroup[]) {
  return groups.flatMap((group) =>
    group.messages
      .filter((m) => m.role === "user")
      .flatMap((m, i) => {
        const detail = dialogueDetail(m.content);
        return detail
          ? [{ detail, runId: group.id, messageId: group.sourceIds?.[i] }]
          : [];
      }),
  );
}

export function requiredDetails(groups: readonly MemoryGroup[]) {
  return [...new Set(userDetails(groups).map((source) => source.detail))];
}

// This candidate, including any exact source text restored here, goes through
// the usual summary reviewer, token-budget check and invariant validation.
export function retainDetails(summary: string, details: readonly string[]) {
  return [
    summary,
    ...details.filter((detail) => !summary.includes(detail)),
  ].join("\n");
}

export function findDialogueDetail(
  groups: readonly MemoryGroup[],
  question: string,
  cards: readonly TopicCard[],
) {
  if (!/[?？]\s*$/u.test(question)) return;
  // A question may share its descriptive words with a detail from another
  // trip. Keep a named card in scope without treating its name as the answer.
  const labels = cards.map(
    (card) => new Set(topicWords([card.description, ...card.tags].join(" "))),
  );
  const queryTerms = topicWords(question);
  const named = labels.flatMap((terms, i) =>
    [...terms].filter(
      (word) =>
        queryTerms.includes(word) &&
        labels.every((other, j) => j === i || !other.has(word)),
    ),
  );
  const excluded = new Set(
    topicWords(
      "what which where who were does that this with from какой какая какое какие где что это был была было были для the and " +
        cards.map((c) => [c.description, ...c.tags].join(" ")).join(" "),
    ),
  );
  const query = new Set(topicWords(question).filter((w) => !excluded.has(w)));
  const matches = userDetails(groups).filter(({ detail }) => {
    const terms = new Set(topicWords(detail));
    if (named.length && !named.some((word) => terms.has(word))) return false;
    const overlap = [...query].filter((w) => terms.has(w));
    const literal = Array.from(detail.matchAll(/[«“"]([^»”"]+)[»”"]/gu), (m) =>
      topicWords(m[1]),
    );
    return (
      overlap.length >= 2 ||
      overlap.some((w) => literal.some((words) => words.includes(w)))
    );
  });
  if (!matches.length || new Set(matches.map((m) => m.detail)).size !== 1)
    return;
  const { detail, runId, messageId } = matches[0];
  return {
    dialogueDetail: detail,
    original: { runId, messageId, role: "user", excerpt: detail },
  };
}
