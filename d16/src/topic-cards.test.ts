import { expect, it } from "vitest";
import { applyTopic, routeTopicDecision, versions, type Catalog } from "./topic-cards";

it("tracks complete values in source order, with independent field versions and an as-of lookup", () => {
  const catalog: Catalog = { cards: [] };
  function write(
    order: number,
    field: string,
    value: string | string[],
    time: number,
    id = "lake",
  ) {
    return applyTopic(
      catalog,
      {
        action: "write",
        id,
        description: "Lake trip",
        tags: ["trip"],
        changes: [{ field, value, evidence: "agreed" }],
      },
      { id: order === 1 ? "lake" : "msg-" + order, at: time, order },
      "agreed",
    );
  }
  write(1, "date", "July 20", 1, "new");
  write(2, "roster", ["Sergey", "Lena", "Katya", "Vova"], 2);
  write(4, "roster", ["Sergey", "Lena", "Vasya"], 4);
  write(3, "date", "August 4", 3);
  write(5, "roster", ["Sergey", "Lena", "Vasya"], 4);
  write(3, "date", "August 4", 3);
  const card = catalog.cards[0];
  expect(versions(card, "roster")).toHaveLength(2);
  expect(versions(card, "date")).toHaveLength(2);
  const read = (query: object) =>
    applyTopic(
      catalog,
      { action: "read", queries: [{ id: "lake", field: "roster", ...query }] },
      { id: "read", order: 6, at: 5 },
      "?",
    );
  expect(read({ at: { field: "date", version: 2 } })).toMatchObject([{value: card.changes[1].value, event: {field:'date', value:'August 4', previous:'July 20'}, effectiveRecord:{field:'roster', id:'msg-2'}}]);
  expect(read({ version: 2 })).toEqual(read({}));
  expect(read({})).toEqual([
    { topic: "Lake trip", field: "roster", value: ["Sergey", "Lena", "Vasya"] },
  ]);
});

it("keeps pending source and clarified target through serialization and repeated processing", () => {
  const c: Catalog = { cards: [] },
    source = (id: string, n: number) => ({ id, order: n, at: n });
  for (const id of ["lake", "sea"])
    applyTopic(
      c,
      {
        action: "write",
        id: "new",
        description: id,
        tags: ["trip"],
        changes: [],
      },
      source(id, 1),
      id,
    );
  applyTopic(
    c,
    { action: "clarify", question: "Which trip?" },
    source("withdraw", 2),
    "Sergey cannot come",
  );
  const restored: Catalog = JSON.parse(JSON.stringify(c));
  const plan = {
    action: "write",
    id: "lake",
    description: "Lake with friends",
    tags: ["trip", "friends"],
    changes: [
      { field: "withdrawals", value: ["Sergey"], evidence: "cannot come" },
    ],
  };
  applyTopic(restored, plan, source("clarify", 3), "lake");
  applyTopic(restored, plan, source("clarify", 3), "lake");
  expect(restored.cards[0].changes).toHaveLength(1);
  expect(restored.pending).toBeUndefined();
  expect(restored.cards[0].changes[0]).toMatchObject({ id: "withdraw", at: 2 });
  expect(restored.cards[1].changes).toEqual([]);
});

it("breaks equal wall-clock times by message order when looking up an earlier roster", () => {
  const c: Catalog = { cards: [] };
  for (const [order, field, value] of [
    [1, "participants", "One"],
    [2, "date", "Tomorrow"],
    [3, "participants", "Two"],
  ] as const) {
    applyTopic(
      c,
      {
        action: "write",
        id: order === 1 ? "new" : "m1",
        description: "Lake",
        tags: ["trip"],
        changes: [{ field, value, evidence: value }],
      },
      { id: "m" + order, at: 100, order },
      value,
    );
  }
  expect(
    applyTopic(
      c,
      {
        action: "read",
        queries: [
          {
            id: "m1",
            field: "participants",
            at: { field: "date", version: 1 },
          },
        ],
      },
      { id: "q", at: 101, order: 4 },
      "?",
    ),
  ).toMatchObject([{ topic: "Lake", field: "participants", value: "One", event:{order:2, evidence:"Tomorrow"}, effectiveRecord:{order:1, evidence:"One"} }]);
});

it("retrieves the roster effective at the second reschedule, by version or exact UTC instant", () => {
  const catalog: Catalog = { cards: [] };
  const writes = [
    ["2026-07-01T09:00:00.000Z", "date", "July 20"],
    ["2026-07-01T09:05:00.000Z", "participants", ["Sergey", "Lena", "Katya"]],
    ["2026-07-03T12:00:00.000Z", "date", "August 4"],
    ["2026-07-03T18:00:00.000Z", "participants", ["Lena", "Katya"]],
    ["2026-07-04T12:00:00.123Z", "date", "August 12"],
    ["2026-07-04T12:00:00.124Z", "participants", ["Lena"]],
  ] as const;
  writes.forEach(([when, field, value], order) => {
    const evidence = typeof value === "string" ? value : value.join(", ");
    applyTopic(catalog, {
      action: "write", id: order === 0 ? "new" : "m0",
      description: "Lake trip", tags: ["trip"],
      changes: [{ field, value, evidence }],
    }, { id: "m" + order, at: Date.parse(when), order: order + 1 }, evidence);
  });
  const queries = [
    {version: 2},
    {time: "2026-07-04T12:00:00.123Z"},
    {at: {field: "date", version: 3}},
    {},
  ].map(selector => ({id: "m0", field: "participants", ...selector}));
  const report = applyTopic(catalog, {action: "read", queries},
    {id: "lookup", at: Date.parse("2026-07-10T12:00:00.000Z"), order: 7}, "?");
  expect(report).toMatchObject([["Lena", "Katya"], ["Lena", "Katya"], ["Lena", "Katya"], ["Lena"]]
    .map(value => ({topic: "Lake trip", field: "participants", value})));
});


it("resolves advice to one card without recording assignments", () => {
  const catalog: Catalog = {cards:[{id:"mountains",description:"Горы",tags:["поездка"],changes:[]}]};
  const ask = "Как лучше распределить обязанности между участниками поездки?";
  applyTopic(catalog, {action:"clarify", intent:"read", question:"Для какой поездки?"}, {id:"ask",at:1,order:1}, ask);
  const view = applyTopic(catalog, {action:"read", queries:[{id:"mountains"}]}, {id:"reply",at:2,order:2}, "Давай для гор");
  expect(view).toMatchObject({originalQuestion:ask, selectedRecords:[{id:"mountains"}]});
  expect(catalog.active).toBe("mountains");
  expect(catalog.pending).toBeUndefined();
  expect(catalog.cards[0].changes).toEqual([]);
});

it("reports changed versus already current dates from the recorded field values", () => {
  const catalog: Catalog = {cards:[]};
  for (const [i, date] of ["20 июля", "4 августа", "4 августа"].entries()) {
    const view = applyTopic(catalog, {action:"write", id:i ? "lake" : "new", description:"Озеро",tags:[],changes:[{field:"date",value:date,evidence:date}]},
      {id:i ? "m"+i : "lake",at:i,order:i+1}, date);
    expect(view).toMatchObject({recordedChanges:[{status:i===2?"already_current":"changed",value:date}]});
  }
  expect(versions(catalog.cards[0],"date")).toHaveLength(2);
});

it("asks before giving unqualified advice when several matching trips exist", () => {
  const catalog: Catalog = {active:"sea",cards:["море","горы"].map(id=>({id,description:"Поездка: "+id,tags:["поездка",id],changes:[]}))};
  const read = {action:"read",queries:[{id:"море"}]};
  expect(routeTopicDecision(catalog, read, "Как лучше распределить обязанности между участниками поездки?")).toMatchObject({action:"clarify",intent:"read"});
  expect(routeTopicDecision(catalog, read, "Как лучше распределить обязанности для поездки на море?")).toEqual(read);
  expect(routeTopicDecision(catalog, {action:"write",id:"море",changes:[{field:"assignments"}]}, "Как лучше распределить обязанности на море?")).toEqual(read);
  expect(routeTopicDecision(catalog, {action:"dialogue"}, "Как лучше учиться?")).toEqual({action:"dialogue"});
});

const topicSource = (id:string, order:number) => ({id,order,at:order});
const lakeWrite = (id:string, value:string, evidence:string) => ({
  action:"write",id,description:"Озеро",tags:["озеро"],changes:[{field:"date",value,evidence}]
});

it("stores only the exact source span when an extractor adds quotation marks",()=>{
  for(const [original,proposed,stored] of [
    ["Дата: 20 июля.", "«Дата: 20 июля.»", "Дата: 20 июля."],
    ["Дата: 20 июля.", "Дата: 20 июля.", "Дата: 20 июля."],
    ["Он сказал «Дата: 20 июля.»", "«Дата: 20 июля.»", "«Дата: 20 июля.»"],
  ]){
    const c: Catalog={cards:[]};
    applyTopic(c,lakeWrite("new","20 июля",proposed),topicSource("m",1),original);
    expect(c.cards[0].changes[0].evidence).toBe(stored);
  }
  for(const invalid of ["«Дата: 20 июня.»","«Дата: 20 июля.”","«Дата:  20 июля.»"]){
    const c: Catalog={cards:[]};
    const plan=lakeWrite("new","20 июля","Дата: 20 июля.");
    plan.changes.push({field:"other",value:"invented",evidence:invalid});
    expect(()=>applyTopic(c,plan,topicSource("m",1),"Дата: 20 июля.")).toThrow("evidence");
    expect(c).toEqual({cards:[]});
  }
});

it("records confirmations separately, including when an older change arrives later",()=>{
  const c:Catalog={cards:[]};
  for (const [n,value] of [[1,"Monday"],[3,"Monday"]] as const)
    applyTopic(c,lakeWrite(n===1?"new":"lake",value,value),topicSource(n===1?"lake":"repeat",n),value);
  expect(c.cards[0].changes).toHaveLength(1);
  expect(c.cards[0].confirmations).toHaveLength(1);
  expect(versions(c.cards[0],"date")).toHaveLength(1);
  applyTopic(c,lakeWrite("lake","Friday","Friday"),topicSource("delayed",2),"Friday");
  expect(versions(c.cards[0],"date").map(e=>e.value)).toEqual(["Monday","Friday","Monday"]);
});

it("applies a grounded multi-card source atomically, without selecting a different trip",()=>{
  const c:Catalog={cards:["озеро","горы","море"].map(id=>({id,description:id,tags:[id],changes:[]})),active:"море"};
  const lines=["на озере берём термос","в горах нужны носки","на море проверим расписание"];
  const updates=c.cards.map((card,i)=>({id:card.id,description:card.description,tags:card.tags,
    changes:[{field:"notes",value:[lines[i]],evidence:lines[i]}]}));
  const source=topicSource("one-turn",1), text=lines.join("; ");
  for(const invalid of [
    [updates[0],{...updates[1],id:"new"}], [updates[0],updates[0]],
    [updates[0],{...updates[1],changes:updates[2].changes}],
    [updates[0],{...updates[1],changes:[{field:"notes",value:"x",evidence:"missing"}]}]
  ]){
    const before=structuredClone(c);
    expect(()=>applyTopic(c,{action:"write",updates:invalid},source,text)).toThrow();
    expect(c).toEqual(before);
  }
  for(let i=0;i<2;i++) applyTopic(c,{action:"write",updates},source,text);
  expect(c.active).toBe("море");
  expect(c.cards.map(card=>card.changes.map(ch=>[ch.id,ch.value]))).toEqual(lines.map(line=>[["one-turn",[line]]]));
});

it("binds a withdrawal and its clarification to separate sources and only the named existing card", () => {
  const instruction = "Лена не сможет поехать", reply = "На море";
  const initial: Catalog = {cards: ["озеро", "море"].map((id, i) => ({
    id, description: id, tags: [id], changes: [{id, at: i, order: i, field:"participants",
      value: i ? ["Лена","Олег","Вера"] : ["Сергей","Лена"], evidence:"Лена"}]
  }))};
  applyTopic(initial, {action:"clarify", intent:"write", question:"О какой поездке речь?"}, topicSource("withdraw",3), instruction);
  const resolution = topicSource("reply",4);
  const edit = (id: string, evidence: unknown) => ({action:"write", id, description:id, tags:[id],
    changes:[{field:"participants", value:["Олег","Вера"], evidence}]});
  for (const bad of [
    edit("озеро", instruction), edit("new", instruction), edit("море", "Лена передумала; На море"),
    edit("море", {instruction, clarification:"на озеро"}), edit("море", "Лена; На море"),
    edit("море", "Лена не сможет поехать; На море; лишний текст"),
    {...edit("море", instruction), changes:[...edit("море", instruction).changes, {field:"notes",value:"x",evidence:"invented"}]},
  ]) {
    const prior = structuredClone(initial);
    expect(() => applyTopic(initial, bad, resolution, reply)).toThrow();
    expect(initial).toEqual(prior);
  }
  for (const ambiguous of ["Не на море", "На море или куда-нибудь ещё?"]) {
    const before = structuredClone(initial);
    expect(() => applyTopic(initial, edit("море", instruction), resolution, ambiguous)).toThrow();
    expect(initial).toEqual(before);
  }
  for (const evidence of [instruction, instruction+"; "+reply, {instruction:"«"+instruction+"»", clarification:"«"+reply+"»"}]) {
    const catalog = structuredClone(initial);
    for(let i=0;i<2;i++)
      expect(applyTopic(catalog, edit("море", evidence), resolution, reply)).toMatchObject({recordedChanges:[
        {field:"participants",status:"changed",previous:["Лена","Олег","Вера"],value:["Олег","Вера"]}
      ]});
    expect(catalog.pending).toBeUndefined();
    expect(catalog.cards[0]).toEqual(initial.cards[0]);
    expect(catalog.cards[1].changes).toHaveLength(2);
    expect(catalog.cards[1].changes[1]).toEqual({...topicSource("withdraw",3),field:"participants",
      value:["Олег","Вера"],evidence:instruction,resolvedBy:{...resolution,evidence:reply}});
  }
});
