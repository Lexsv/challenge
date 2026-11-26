import { describe, expect, it } from "vitest";
import qa from "./test-fixtures/terra-v5-memory.json";
import { parseMemoryProposal } from "./memory-proposal";
import {
  mapMemoryTopic,
  resolveProposalTarget,
} from "./memory-proposal-mapper";
import { applyTopic, versions, type Catalog } from "./topic-cards";

const origin = { id: "user-turn", at: 100, order: 10 };
const cite = (quote: string) => ({ source: "current", quote });
const envelope = (topic: unknown) => ({ version: 1, facts: [], topic });
const baseline = (): Catalog => ({
  cards: qa.cards.map((c) => ({
    id: c.id,
    description: c.description,
    tags: c.tags,
    changes: [
      {
        id: "prior",
        order: 1,
        at: 10,
        field: "notes",
        value: c.notes,
        evidence: c.notes.join(" "),
      },
    ],
  })),
});
function execute(catalog: Catalog, message: string, topic: unknown) {
  const proposal = parseMemoryProposal(envelope(topic));
  const plan = mapMemoryTopic(
    resolveProposalTarget(proposal.topic, catalog, message),
    catalog,
    message,
    origin,
  );
  return applyTopic(catalog, plan, origin, message);
}
describe("Terra v5 provider capture", () => {
  it.each(qa.creations)(
    "line $line: date and complete roster share one sentence",
    (record) => {
      const catalog: Catalog = { cards: [] };
      expect(() => parseMemoryProposal(record.response)).toThrow();
      expect(() => parseMemoryProposal(record.repair)).toThrow();
      const { tags, description, changes } = record.response.topic;
      const date = changes[0],
        roster = changes[1];
      const target = {
        kind: "new",
        description,
        tags,
        mention: cite(record.message.split(":")[0]),
      };
      execute(catalog, record.message, {
        kind: "write",
        updates: [
          {
            target,
            edits: [
              {
                kind: "set",
                field: "date",
                value: date.value,
                evidence: cite(date.evidence),
              },
              {
                kind: "set_roster",
                names: roster.value,
                evidence: cite(roster.evidence),
              },
            ],
          },
        ],
      });
      const card = catalog.cards[0];
      expect(card.changes.map((v) => v.value)).toEqual([
        date.value,
        roster.value,
      ]);
      for (const v of card.changes)
        expect(
          record.message.slice(
            v.evidenceStart!,
            v.evidenceStart! + v.evidence.length,
          ),
        ).toBe(v.evidence);
    },
  );
  it("replaces the unsupported items object array with a grounded assignment", () => {
    const { response, message } = qa.assignment;
    expect(() => parseMemoryProposal(response)).toThrow();
    const catalog = baseline(),
      card = catalog.cards[0];
    card.changes = [];
    const evidence = response.topic.changes[2].evidence;
    const update = {
      target: { kind: "existing", card: card.id, mention: cite("озеро") },
      edits: [
        {
          kind: "assign",
          person: "Лена",
          item: "термос",
          evidence: cite(evidence),
        },
      ],
    };
    expect(() =>
      execute(catalog, message, {
        kind: "write",
        updates: [
          { ...update, edits: [{ ...update.edits[0], person: "Катя" }] },
        ],
      }),
    ).toThrow();
    execute(catalog, message, { kind: "write", updates: [update] });
    expect(catalog.cards[0].changes[0].value).toEqual([evidence]);
  });
  it.each(qa.batch)(
    "line $line: four scoped deltas and no prefix on failure",
    (record) => {
      expect(() => parseMemoryProposal(record.response)).toThrow();
      const updates = record.response.topic.updates.map((u) => {
        const clause = u.changes[0].evidence;
        return {
          target: { kind: "existing", card: u.id, mention: cite(clause) },
          edits: [{ kind: "append_note", evidence: cite(clause) }],
        };
      });
      const catalog = baseline(),
        before = structuredClone(catalog);
      const wrong = structuredClone(updates);
      wrong[3].edits[0].evidence = wrong[1].edits[0].evidence;
      expect(() =>
        execute(catalog, record.message, { kind: "write", updates: wrong }),
      ).toThrow();
      expect(catalog).toEqual(before);
      execute(catalog, record.message, { kind: "write", updates });
      for (const [i, c] of catalog.cards.entries())
        expect(versions(c, "notes").at(-1)?.value).toEqual([
          ...qa.cards[i].notes,
          updates[i].edits[0].evidence.quote,
        ]);
    },
  );
});
it.each([
  {},
  { version: 2, facts: [], topic: { kind: "dialogue" } },
  { ...envelope({ kind: "dialogue" }), revision: 2 },
  envelope({ kind: "write", updates: [{ card: "other-session" }] }),
  envelope({ kind: "dialogue", commit: true }),
])("rejects malformed or unknown contract members", (value) => {
  expect(() => parseMemoryProposal(value)).toThrow();
});

it("keeps the clarified withdrawal bound to its original user and reply", () => {
  const catalog = baseline();
  for (const card of catalog.cards.slice(0, 3))
    card.changes.push({
      id: card.id,
      at: 2,
      order: 1,
      field: "participants",
      value: ["Лена", "Вера", "Олег"],
      evidence: "Лена, Вера, Олег",
    });
  const original = "Лена не сможет поехать.";
  applyTopic(
    catalog,
    { action: "clarify", intent: "write", question: "О какой поездке речь?" },
    { id: "pending", at: 5, order: 2 },
    original,
  );
  const sea = catalog.cards[2];
  const write = {
    kind: "write",
    updates: [
      {
        target: { kind: "existing", card: sea.id, mention: cite("море") },
        edits: [
          {
            kind: "withdraw",
            person: "Лена",
            evidence: { source: "pending", quote: original },
          },
        ],
      },
    ],
  };
  execute(catalog, "На море.", write);
  expect(sea.id).toBe(catalog.cards[2].id);
  expect(catalog.cards[2].changes.at(-1)).toMatchObject({
    value: ["Вера", "Олег"],
    id: "pending",
    resolvedBy: { id: origin.id },
  });
  expect(versions(catalog.cards[0], "participants")).toHaveLength(1);
  expect(catalog.pending).toBeUndefined();
});
it("rejects a clipped date and an assignment quoted from a supposition", () => {
  const catalog = baseline(),
    card = catalog.cards[0];
  for (const [message, edit] of [
    [
      "Переносим озеро на 25 июля 2027 года.",
      {
        kind: "set",
        field: "date",
        value: "2027-07-05",
        evidence: cite("5 июля 2027 года"),
      },
    ],
    [
      "На озеро Ира думает, что Лена берёт термос.",
      {
        kind: "assign",
        person: "Лена",
        item: "термос",
        evidence: cite("Лена берёт термос"),
      },
    ],
  ] as const)
    expect(() =>
      execute(catalog, message, {
        kind: "write",
        updates: [
          {
            target: { kind: "existing", card: card.id, mention: cite("озеро") },
            edits: [edit],
          },
        ],
      }),
    ).toThrow(/evidence/);
});
it("an explicit rename preserves card identity and previous field history", () => {
  const catalog = baseline(),
    before = structuredClone(catalog.cards[0]);
  execute(catalog, "Переименуй озеро: Летний отдых.", {
    kind: "write",
    updates: [
      {
        target: { kind: "existing", card: before.id, mention: cite("озеро") },
        edits: [
          {
            kind: "set",
            field: "description",
            value: "Летний отдых",
            evidence: cite("Летний отдых"),
          },
        ],
      },
    ],
  });
  expect(catalog.cards[0]).toEqual({ ...before, description: "Летний отдых" });
});

it("a grounded ISO date repeats an older localized value without a new historical version", () => {
  const c = baseline(),
    card = c.cards[0];
  card.changes.push({
    field: "date",
    id: "earlier",
    at: 1,
    order: 1,
    value: "20 июля 2027 года",
    evidence: "20 июля 2027 года",
  });
  execute(c, "Озеро: 2027-07-20.", {
    kind: "write",
    updates: [
      {
        target: { kind: "existing", card: card.id, mention: cite("Озеро") },
        edits: [
          {
            kind: "set",
            field: "date",
            value: "2027-07-20",
            evidence: cite("2027-07-20"),
          },
        ],
      },
    ],
  });
  expect(versions(c.cards[0], "date")).toHaveLength(1);
  expect(c.cards[0].confirmations?.[0].value).toBe("20 июля 2027 года");
});

describe("new proposals referencing the existing catalog", () => {
  const card = (id: string, description: string) => ({
    id,
    description,
    tags: [],
    changes: [],
  });
  const newTopic = (name: string) => ({
    kind: "write",
    updates: [
      {
        target: {
          kind: "new",
          description: name,
          tags: [],
          mention: cite(name),
        },
        edits: [],
      },
    ],
  });
  it("resolves the cited destination even when the name and the catalog wording differ", () => {
    const catalog: Catalog = {
      cards: [card("lake", "Отдых на озере с друзьями")],
    };
    execute(catalog, "Поездка на озеро", newTopic("Поездка на озеро"));
    expect(catalog.cards.map((c) => c.id)).toEqual(["lake"]);
    expect(catalog.active).toBe("lake");
  });
  it("asks before writing when two trips share the cited destination", () => {
    const catalog: Catalog = {
      active: "a",
      cards: [card("a", "Friends lake trip"), card("b", "Family lake trip")],
    };
    execute(catalog, "Lake trip: date is tomorrow.", newTopic("Lake trip"));
    expect(catalog.pending).toMatchObject({
      intent: "write",
      text: "Lake trip: date is tomorrow.",
    });
    expect(catalog.cards).toHaveLength(2);
  });
  it("does not merge a new qualifier into a partially matching name", () => {
    const catalog: Catalog = { cards: [card("a", "Friends lake trip")] };
    execute(
      catalog,
      "Family lake trip: date is tomorrow.",
      newTopic("lake trip"),
    );
    expect(catalog.pending?.intent).toBe("write");
    expect(catalog.cards).toHaveLength(1);
  });
  it("allows a separate trip and preserves a concrete note alongside planning intent", () => {
    const catalog: Catalog = { cards: [card("old", "Lake trip")] };
    const message = "Let's plan a separate lake trip. Camping is permitted.";
    execute(catalog, message, {
      kind: "write",
      updates: [
        {
          target: {
            kind: "new",
            description: "Separate lake trip",
            tags: [],
            mention: cite("lake trip"),
          },
          edits: [
            {
              kind: "append_note",
              evidence: cite("Let's plan a separate lake trip."),
            },
            { kind: "append_note", evidence: cite("Camping is permitted.") },
          ],
        },
      ],
    });
    expect(catalog.cards).toHaveLength(2);
    expect(catalog.cards[1].changes.map((c) => c.value)).toEqual([
      ["Camping is permitted."],
    ]);
  });
});

it("a place name starting with New does not authorize a duplicate card", () => {
  const catalog: Catalog = {
    cards: [{ id: "ny", description: "New York trip", tags: [], changes: [] }],
  };
  execute(catalog, "New York trip: date is tomorrow.", {
    kind: "write",
    updates: [
      {
        target: {
          kind: "new",
          description: "New York trip",
          tags: [],
          mention: cite("New York trip"),
        },
        edits: [
          {
            kind: "set",
            field: "date",
            value: "tomorrow",
            evidence: cite("tomorrow"),
          },
        ],
      },
    ],
  });
  expect(catalog.cards.map((c) => c.id)).toEqual(["ny"]);
});

import v7 from "./test-fixtures/terra-v7-memory.json";
const originalRoster = ["Сергей","Лена","Катя"];
const changedRoster = ["Сергей","Лена","Вера"];
function rosterCatalog(): Catalog {
  const lake = {id:v7[13].proposal.topic.updates[0].target.card,description:"Поездка на озеро",tags:["озеро"],
    changes:[{id:"first",at:1,order:1,field:"participants",value:[...originalRoster],evidence:"Едут Сергей, Лена и Катя."}]};
  return {active:lake.id,cards:[lake,{...structuredClone(lake),id:"sea",description:"Поездка на море",tags:["море"]}]};
}
describe("Terra v7 roster evidence", () => {
  it.each([v7[13],v7[15],v7[17],v7[18]])("commits one grounded version for $message", record => {
    const catalog=rosterCatalog();
    execute(catalog,record.message,record.proposal.topic);
    expect(versions(catalog.cards[0],"participants").map(v=>v.value)).toEqual([originalRoster,changedRoster]);
    expect(versions(catalog.cards[1],"participants").map(v=>v.value)).toEqual([originalRoster]);
  });
  it.each(["invented bystander","wrong card","missing outgoing","incoming already present","conditional"])("rejects %s atomically", variant => {
    const catalog=rosterCatalog(), topic=structuredClone(v7[13].proposal.topic), update=topic.updates[0];
    let message=v7[13].message;
    if (variant==="invented bystander") update.edits[0].names[1]="Олег";
    if (variant==="wrong card") update.target.card="sea";
    if (variant==="missing outgoing") catalog.cards[0].changes[0].value=["Сергей","Лена"];
    if (variant==="incoming already present") catalog.cards[0].changes[0].value=[...originalRoster,"Вера"];
    if (variant==="conditional") message="Если "+message;
    const before=structuredClone(catalog);
    expect(()=>execute(catalog,message,topic)).toThrow();
    expect(catalog).toEqual(before);
  });
});
