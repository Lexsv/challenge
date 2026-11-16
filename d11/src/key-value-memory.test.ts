import { expect, it, vi } from 'vitest';
import type { ManagerLlmAdapter } from './manager-agent';
import { maintainMemory, memoryAnswerContext, selectMemory } from './key-value-memory';
import { ManagerAgent, createManagerConversation } from './manager-agent';
import { ToolRegistry } from './tool-runtime';

const assessment = (entries: readonly {id: string}[], selected: readonly string[]) => JSON.stringify({matches: entries.map(({id}) => ({id, match: selected.includes(id)}))});

const regressionTopics = [
  {id:'p3',key:'Пикник 3 сентября',value:'Для пикника 3 сентября Эдуард приносит огурцы. Время встречи — 12:45.'},
  {id:'math',key:'Математическая задача: 48 и 6',value:'Исходное число 48, делитель 6.'},
  {id:'history',key:'Карибский кризис — причины — октябрь 1962',value:'Договорились сосредоточиться на причинах кризиса.'},
  {id:'p4',key:'Пикник 4 сентября — огурцы от Норы',value:'Для отдельного пикника 4 сентября Нора приносит огурцы.'},
];

it.each([
  ['Кто приносит огурцы на пикник?', ['p3','p4'], '3 сентября — Эдуард; 4 сентября — Нора.'],
  ['Кто приносит огурцы на пикник 3 сентября?', ['p3'], 'Эдуард.'],
] as const)('regression: asymmetric key descriptions, %s', async (question, selected, response) => {
  const complete=vi.fn<ManagerLlmAdapter['complete']>()
    .mockResolvedValueOnce({text:assessment(regressionTopics,selected)})
    .mockResolvedValueOnce({text:response});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:10000}),summarize:async()=>''}};
  const state=createManagerConversation();
  state.messages.push({id:'old',conversationId:state.conversation.id,runId:'old-run',role:'user',type:'text',text:'Полная история не должна передаваться.',createdAt:1});
  const result=await new ManagerAgent(adapter,new ToolRegistry()).run({state,userText:question,keyValue:{load:async()=>regressionTopics,save:async()=>{throw Error('Questions must not update memory');}}});
  expect(result.finalResponse).toBe(response);
  expect(complete).toHaveBeenCalledTimes(2);
  const first=complete.mock.calls[0][0];
  expect(first.tools).toEqual([]);
  expect(first.messages).toHaveLength(2);
  expect(JSON.parse(first.messages[1].content!)).toEqual({question,topics:regressionTopics.map(({id,key})=>({id,key}))});
  const second=complete.mock.calls[1][0].messages;
  expect(second).toHaveLength(2);
  expect(second[1]).toEqual({role:'user',content:question});
  const values=JSON.parse(second[0].content!.split('\n').at(-1)!);
  expect(values).toEqual(regressionTopics.filter(entry=>(selected as readonly string[]).includes(entry.id)).map(({key,value})=>({key,value})));
});

it.each([
  ['missing topic', [{id:'p4',match:true}], 'every topic'],
  ['duplicate topic', [...regressionTopics.map(({id})=>({id,match:false})),{id:'p3',match:true}], 'more than once'],
  ['unknown topic', [{id:'unknown',match:true}], 'unknown topic'],
  ['non-boolean decision', [{id:'p3',match:'true'}], 'invalid topic assessment'],
])('rejects %s before sending any Values to the answer model', async (_label, matches, error) => {
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:JSON.stringify({matches})});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:10000}),summarize:async()=>''}};
  await expect(selectMemory(adapter,regressionTopics,'Кто приносит огурцы на пикник?')).rejects.toThrow(error);
  expect(complete).toHaveBeenCalledTimes(1);
  for(const {value} of regressionTopics) expect(JSON.stringify(complete.mock.calls[0][0].messages)).not.toContain(value);
});

it('returns none only after all topics have been assessed as nonmatches', async () => {
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:assessment(regressionTopics,[])});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:10000}),summarize:async()=>''}};
  expect(await selectMemory(adapter,regressionTopics,'Что решили о ремонте машины?')).toEqual({kind:'none'});
});

it('creates all four original topics on their first turn after an ambiguous update selection', async () => {
  const setup=[
    'Для пикника 3 сентября Эдуард приносит огурцы. Запомни эту договорённость и ответь кратко по-русски.',
    'В математической задаче договорились взять исходное число 48 и делить его на 6. Пока только запомни выбранные числа, не вычисляй. Ответь кратко по-русски.',
    'В обсуждении Карибского кризиса октября 1962 года договорились сосредоточиться на его причинах. Запомни этот фокус и ответь кратко по-русски.',
    'Для пикника 4 сентября Нора приносит огурцы. Это отдельный пикник. Запомни договорённость и ответь кратко по-русски.',
  ];
  const answers=[
    '{"action":"upsert","key":"Пикник 3 сентября","value":"Эдуард приносит огурцы."}',
    '{"selection":"none"}', '{"action":"upsert","key":"Математическая задача","value":"Исходное число 48, делитель 6."}',
    '{"selection":"ambiguous"}', '{"selection":"none"}', '{"action":"upsert","key":"Карибский кризис 1962","value":"Обсудить причины."}',
    '{"selection":"none"}', '{"action":"upsert","key":"Пикник 4 сентября","value":"Нора приносит огурцы."}',
  ];
  const complete=vi.fn<ManagerLlmAdapter['complete']>(async()=>({text:answers.shift()}));
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:1000}),summarize:async()=>''}};
  let entries:import('./key-value-memory').MemoryEntry[]=[];
  for (const message of setup) entries=(await maintainMemory(adapter,entries,message)).entries;
  expect(entries.map(entry=>entry.key)).toEqual(['Пикник 3 сентября','Математическая задача','Карибский кризис 1962','Пикник 4 сентября']);
  expect(entries[1].value).toContain('48'); expect(entries[1].value).toContain('6');
  expect(answers).toEqual([]);
});

it('does not treat a new statement as a clarification of a prior statement', async () => {
  let entries=[{id:'a',key:'Пикник 3 сентября',value:'Эдуард приносит огурцы.'}];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:'{"selection":"ambiguous"}'}).mockResolvedValueOnce({text:'{"selection":"ambiguous"}'}).mockResolvedValueOnce({text:'{"selection":"none"}'}).mockResolvedValueOnce({text:'{"action":"upsert","key":"Пикник 4 сентября","value":"Нора приносит огурцы."}'}).mockResolvedValueOnce({text:'Запомнил.'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:1000}),summarize:async()=>''}};
  const manager=new ManagerAgent(adapter,new ToolRegistry()), state=createManagerConversation();
  const keyValue={load:async()=>entries,save:async(next:typeof entries)=>{entries=next;}};
  const history='В обсуждении Карибского кризиса октября 1962 года договорились сосредоточиться на его причинах. Запомни этот фокус и ответь кратко по-русски.';
  await manager.run({state,userText:history,keyValue});
  await manager.run({state,userText:'Для пикника 4 сентября Нора приносит огурцы. Это отдельный пикник. Запомни договорённость и ответь кратко по-русски.',keyValue});
  expect(entries.map(entry=>entry.key)).toEqual(['Пикник 3 сентября','Пикник 4 сентября']);
  expect(JSON.stringify(complete.mock.calls[2][0].messages)).not.toContain(history);
});

it('retrieves one picnic by description without exposing unrelated values', async () => {
  const entries = [
    { id: 'a', key: 'September 2 picnic', value: 'Nora brings cucumbers at noon.' },
    { id: 'b', key: 'Vacation in June', value: 'The group travels by train.' },
    { id: 'c', key: 'September 9 picnic', value: 'Ivo brings tomatoes at 1pm.' },
  ];
  const complete = vi.fn<ManagerLlmAdapter['complete']>(async () => ({text: assessment(entries, ['a'])}));
  const adapter: ManagerLlmAdapter = {complete, context: {assess:async()=>({tokens:50,modelInputBudget:100}),summarize:async()=>''}};
  const question = 'Who brings cucumbers to the September 2 picnic?';
  const selection = await selectMemory(adapter, entries, question);
  const selectionPayload = JSON.stringify(complete.mock.calls[0][0].messages);
  expect(selectionPayload).not.toContain('Nora brings');
  expect(selectionPayload).not.toContain('travels by train');
  const answerPayload = JSON.stringify(memoryAnswerContext(selection, question));
  expect(answerPayload).toContain('Nora brings cucumbers at noon.');
  expect(answerPayload).not.toContain('Ivo brings tomatoes');
  expect(answerPayload).not.toContain('travels by train');
});

it('merges an explicit update into the matching topic and preserves other topics', async () => {
  const entries = [{id:'a',key:'September 2 picnic',value:'Nora brings cucumbers.'},{id:'b',key:'Vacation',value:'Travel by train.'}];
  const complete = vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:'{"selection":"a"}'}).mockResolvedValueOnce({text:'{"action":"upsert","key":"September 2 picnic","value":"Nora brings cucumbers at noon."}'});
  const adapter: ManagerLlmAdapter = {complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  const updated=await maintainMemory(adapter,entries,'Nora arrives at noon.');
  expect(updated.entries).toEqual([{id:'a',key:'September 2 picnic',value:'Nora brings cucumbers at noon.'},entries[1]]);
  expect(JSON.stringify(complete.mock.calls[0][0].messages)).not.toContain('Travel by train.');
  expect(JSON.stringify(complete.mock.calls[1][0].messages)).not.toContain('Travel by train.');
});

it('requires clarification for ambiguous results and rejects unknown topic IDs', async () => {
  const entries = [{id:'a', key:'First picnic', value:'one'}, {id:'b', key:'Second picnic', value:'two'}];
  const complete = vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:'{"selection":"ambiguous"}'}).mockResolvedValueOnce({text:'{"matches":[{"id":"unknown","match":true}]}'});
  const adapter: ManagerLlmAdapter = {complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  expect(() => memoryAnswerContext({kind:'ambiguous'}, 'Which picnic?')).toThrow('clarify');
  expect(await selectMemory(adapter, entries, 'Which picnic?')).toEqual({kind:'ambiguous'});
  await expect(selectMemory(adapter, entries, 'Which picnic?')).rejects.toThrow('unknown topic');
});

it('sends only the selected picnic value through the Manager answer request', async () => {
  const entries=[{id:'a',key:'September 2 picnic',value:'Nora brings cucumbers.'},{id:'b',key:'Vacation',value:'Train to mountains.'},{id:'c',key:'September 9 picnic',value:'Ivo brings tomatoes.'}];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:assessment(entries,['a'])}).mockResolvedValueOnce({text:'Nora brings cucumbers.'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  const result=await new ManagerAgent(adapter,new ToolRegistry()).run({state:createManagerConversation(),userText:'Who brings cucumbers to the September 2 picnic?',keyValue:{load:async()=>entries,save:async()=>{throw Error('Unexpected save');}}});
  expect(result.finalResponse).toBe('Nora brings cucumbers.');
  const answer=JSON.stringify(complete.mock.calls[1][0].messages);
  expect(answer).toContain('Nora brings cucumbers.');
  expect(answer).not.toContain('Train to mountains.');
  expect(answer).not.toContain('Ivo brings tomatoes.');
});

it('selects both dated picnics without sending the vacation value and answers in two calls', async () => {
  const entries=[{id:'a',key:'Пикник 3 сентября',value:'Эдуард приносит огурцы.'},{id:'b',key:'Отпуск в октябре',value:'Поездка на поезде.'},{id:'c',key:'Пикник 4 сентября',value:'Нора приносит огурцы.'}];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:assessment(entries,['a','c'])}).mockResolvedValueOnce({text:'3 сентября — Эдуард, 4 сентября — Нора.'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  const result=await new ManagerAgent(adapter,new ToolRegistry()).run({state:createManagerConversation(),userText:'Кто приносит огурцы на пикник?',keyValue:{load:async()=>entries,save:async()=>{throw Error('Unexpected save');}}});
  expect(result.finalResponse).toBe('3 сентября — Эдуард, 4 сентября — Нора.');
  expect(complete).toHaveBeenCalledTimes(2);
  const selector=JSON.stringify(complete.mock.calls[0][0].messages), answer=JSON.stringify(complete.mock.calls[1][0].messages);
  expect(selector).toContain('Пикник 3 сентября'); expect(selector).not.toContain('Эдуард приносит'); expect(selector).not.toContain('Поездка на поезде');
  expect(answer).toContain('Эдуард приносит'); expect(answer).toContain('Нора приносит'); expect(answer).not.toContain('Поездка на поезде');
});

it('sends only the selected dated picnic to the answer model', async () => {
  const entries=[{id:'a',key:'Пикник 3 сентября',value:'Эдуард приносит огурцы.'},{id:'b',key:'Отпуск',value:'Поезд в горы.'},{id:'c',key:'Пикник 4 сентября',value:'Нора приносит огурцы.'}];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:assessment(entries,['a'])}).mockResolvedValueOnce({text:'Эдуард.'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  await new ManagerAgent(adapter,new ToolRegistry()).run({state:createManagerConversation(),userText:'Кто приносит огурцы на пикник 3 сентября?',keyValue:{load:async()=>entries,save:async()=>{throw Error('Unexpected save');}}});
  expect(complete).toHaveBeenCalledTimes(2);
  const answer=JSON.stringify(complete.mock.calls[1][0].messages);
  expect(answer).toContain('Эдуард приносит'); expect(answer).not.toContain('Нора приносит'); expect(answer).not.toContain('Поезд в горы');
});

it('uses a short clarification to resolve the pending question', async () => {
  const entries=[{id:'a',key:'Пикник 3 сентября',value:'Эдуард приносит огурцы.'},{id:'b',key:'Пикник 4 сентября',value:'Нора приносит огурцы.'}];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:'{"selection":"ambiguous"}'}).mockResolvedValueOnce({text:assessment(entries,['a'])}).mockResolvedValueOnce({text:'Эдуард.'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:100}),summarize:async()=>''}};
  const manager=new ManagerAgent(adapter,new ToolRegistry()), state=createManagerConversation(), keyValue={load:async()=>entries,save:async()=>{throw Error('Unexpected save');}};
  const first=await manager.run({state,userText:'Кто приносит огурцы?',keyValue});
  expect(first.finalResponse).toContain('Пикник 3 сентября');
  const second=await manager.run({state,userText:'Третьего числа',keyValue});
  expect(second.finalResponse).toBe('Эдуард.');
  expect(JSON.stringify(complete.mock.calls[1][0].messages)).toContain('Кто приносит огурцы?');
  expect(JSON.stringify(complete.mock.calls[2][0].messages)).toContain('Кто приносит огурцы?');
});

it('sends only selected values for the four QA follow-up questions', async () => {
  const entries=[{id:'p3',key:'Пикник 3 сентября',value:'Эдуард приносит огурцы.'},{id:'math',key:'Математическая задача',value:'Число 48, делитель 6.'},{id:'history',key:'Карибский кризис',value:'Изучаем причины кризиса.'},{id:'p4',key:'Пикник 4 сентября',value:'Нора приносит огурцы.'}];
  const cases=[['Кто приносит огурцы на пикник?',['p3','p4']],['Кто приносит огурцы на пикник 3 сентября?',['p3']],['Какое исходное число и какой делитель мы выбрали для задачи?',['math']],['На каком аспекте Карибского кризиса мы договорились сосредоточиться?',['history']]] as const;
  for (const [question,ids] of cases) {
    const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({text:assessment(entries,ids)}).mockResolvedValueOnce({text:'Ответ'});
    const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,modelInputBudget:1000}),summarize:async()=>''}};
    await new ManagerAgent(adapter,new ToolRegistry()).run({state:createManagerConversation(),userText:question,keyValue:{load:async()=>entries,save:async()=>{throw Error('Unexpected save');}}});
    expect(complete).toHaveBeenCalledTimes(2);
    const selector=JSON.stringify(complete.mock.calls[0][0].messages), answer=JSON.stringify(complete.mock.calls[1][0].messages);
    expect(selector).toContain(question);
    for (const entry of entries) { expect(selector).toContain(entry.key); expect(selector).not.toContain(entry.value); if ((ids as readonly string[]).includes(entry.id)) expect(answer).toContain(entry.value); else expect(answer).not.toContain(entry.value); }
  }
});
