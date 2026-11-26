import { expect, it } from "vitest";
import { applyTopic, type Catalog } from "./topic-cards.ts";
import { locateEvidence } from "./topic-evidence.ts";

const text =
  "Теперь поход в горы: 25 июля 2027 года. Идут Игорь, Олег и Вера. Олег берёт палатку.";
const source = { id: "mountains", at: 10, order: 2 };
const plan = {
  action: "write",
  id: "new",
  description: "Поход в горы",
  tags: ["поход", "горы"],
  changes: [
    {
      field: "date",
      value: "2027-07-25",
      evidence: "Поход в горы: 25 июля 2027 года.",
    },
    {
      field: "participants",
      value: ["Игорь", "Олег", "Вера"],
      evidence: "Идут Игорь, Олег и Вера.",
    },
    {
      field: "notes",
      value: ["Олег берёт палатку."],
      evidence: "Олег берёт палатку.",
    },
  ],
};
const catalog = (): Catalog => ({
  active: "sea",
  cards: [{ id: "sea", description: "Море", tags: ["море"], changes: [] }],
});

it("replays the Terra write with original UTF-16 offsets and exactly three changes", () => {
  const c = catalog(),
    other = structuredClone(c.cards[0]);
  for (let i = 0; i < 2; i++) applyTopic(c, plan, source, text);
  expect(c.cards[0]).toEqual(other);
  expect(c.cards).toHaveLength(2);
  expect(
    c.cards[1].changes.map((v) => [v.id, v.evidenceStart, v.value]),
  ).toEqual([
    ["mountains", 7, "2027-07-25"],
    ["mountains", 40, ["Игорь", "Олег", "Вера"]],
    ["mountains", 65, ["Олег берёт палатку."]],
  ]);
  for (const v of c.cards[1].changes)
    expect(
      text.slice(v.evidenceStart!, v.evidenceStart! + v.evidence.length),
    ).toBe(v.evidence);
  expect(c.cards[1].changes[0].evidence.startsWith("поход")).toBe(true);
});

it.each([
  ["поход в горы", false],
  ["«поход в горы»", false],
  ["Поход в горы", true],
  ["«ПОХОД В ГОРЫ»", true],
])("locates %s in the original message", (quote, recovered) => {
  expect(locateEvidence(quote, "🗓 Теперь поход в горы")).toEqual({
    start: 10,
    text: "поход в горы",
    recovered,
  });
});

it.each([
  [0, "2027-07-26"],
  [1, ["Игорь", "Олег", "Анна"]],
  [1, ["Игорь", "Вера"]],
  [2, ["Вера берёт палатку."]],
] as const)(
  "rejects a contradictory field %i without changing the catalog",
  (index, value) => {
    for (const dateQuote of [
      plan.changes[0].evidence,
      plan.changes[0].evidence.toLowerCase(),
    ]) {
      const c = catalog(),
        copy = structuredClone(plan);
      copy.changes[0].evidence = dateQuote;
      copy.changes[index].value =
        typeof value === "string" ? value : [...value];
      expect(() => applyTopic(c, copy, source, text)).toThrow(/evidence/);
      expect(c).toEqual(catalog());
    }
  },
);

it("rejects a quotation under another topic, ambiguous matches, and misleading omitted qualifiers", () => {
  for (const [message, evidence] of [
    ["Море: 25 июля 2027 года.", "МОРЕ: 25 июля 2027 года."],
    [
      "Поход в горы: 25 июля 2027 года. Поход в горы: 25 июля 2027 года.",
      "ПОХОД В ГОРЫ: 25 июля 2027 года.",
    ],
    [
      "Отменён поход в горы: 25 июля 2027 года.",
      "Поход в горы: 25 июля 2027 года.",
    ],
    ["Море. Дата: 25 июля 2027 года.", "ДАТА: 25 июля 2027 года."],
  ]) {
    const c = catalog(),
      copy = { ...plan, changes: [{ ...plan.changes[0], evidence }] };
    expect(() => applyTopic(c, copy, source, message)).toThrow(/evidence/);
    expect(c).toEqual(catalog());
  }
});

it("rejects an exact quote borrowed from a different field of the same topic", () => {
  for (const [index, borrowed] of [
    [0, 1],
    [1, 2],
    [2, 0],
  ]) {
    const copy = structuredClone(plan),
      c = catalog();
    copy.changes[0].evidence = copy.changes[0].evidence.toLowerCase();
    copy.changes[index].evidence = copy.changes[borrowed].evidence;
    expect(() => applyTopic(c, copy, source, text)).toThrow(/evidence/);
    expect(c).toEqual(catalog());
  }
});
