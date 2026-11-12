import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionServer} from '../server/sessions.mjs';
import {ManagerAgent} from './manager-agent';
import {createBuiltInToolRegistry} from './tool-runtime';
import {emptySession} from './session-api';
import {restoreHistory,type HistoryEvent} from './conversation-history';
import {eventRunId,mergeHistoryPages,prependedScrollTop} from './history-pagination';
import {buildWeek2Timeline} from './week2-agent-tool-lab';
import {groupChatEvents,logsFailed,ChatRunLog} from './chat-run-log';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {estimateContextInput} from './token-meter';
import {historicalContext} from './context-compaction';

it('anchors prepended content at the same viewport offset and idempotently merges overlapping pages',()=>{
 expect(prependedScrollTop({height:2000,top:35},4200)).toBe(2235);
 expect(prependedScrollTop({height:2000,top:35},1980)).toBe(15);
 const event={id:'one',sessionId:'s',sequence:1,type:'run',payload:{id:'r'}} as HistoryEvent;
 expect(mergeHistoryPages([event],[event])).toEqual([event]);
});

it('loads newest whole turns only, pages backwards without splits/duplicates, restores failures and retains full Manager context',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'d8-history-pages-'));
 const database=join(folder,'history.sqlite');
 let server:ReturnType<typeof createSessionServer>;
 let base='';
 const start=async()=>{
  server=createSessionServer(database,{credentialStore:{status:async()=>false,read:async()=>{throw Error('Empty fake store')},save:async()=>{},forget:async()=>{}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('Missing port');base=`http://127.0.0.1:${address.port}`;
 };
 const stop=()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 const api=async(path='',method='GET',body?:unknown)=>{
  const response=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect(response.ok).toBe(true);return response.json();
 };
 try{
  await start();const session=await api('','POST');const other=await api('','POST');
  const state=emptySession(session);const tools=createBuiltInToolRegistry();
  const onEvent=async(event:HistoryEvent)=>{await api('/'+session.id+'/events','POST',event)};
  const manager=new ManagerAgent({complete:async()=>({text:'Saved answer.'})},tools);
  for(let i=1;i<=45;i++)await manager.run({state,userText:`Turn ${i}: saved dialogue.`,onEvent});
  await new ManagerAgent({complete:async()=>{throw Error('Mock run failure')}},tools).run({state,userText:'Turn 46: failed request.',onEvent});
  // Append an interrupted call to an older run. It must travel with its run,
  // even though the call event has a much newer sequence than that run's messages.
  const oldRun=state.runs[0].id;
  await onEvent({id:'interrupted-call',sessionId:session.id,type:'tool-call',payload:{id:'call',runId:oldRun,toolCallId:'call',toolId:'builtin.tax_calculator',status:'running',arguments:{amount:100,taxRate:10},startedAt:1}});
  const first=await api('/'+session.id+'/events?limit=20');
  expect(new Set(first.events.map(eventRunId)).size).toBe(20);
  expect(first.events.filter((e:HistoryEvent)=>e.type==='message').map((e:any)=>e.payload.text)).not.toContain('Turn 1: saved dialogue.');
  expect(first.events.filter((e:HistoryEvent)=>e.type==='message').at(-1).payload.text).toBe('Turn 46: failed request.');
  expect(first.nextBefore).toBeGreaterThan(0);
  const partial=restoreHistory(emptySession(session),first.events);
  const groups=groupChatEvents(buildWeek2Timeline(partial,tools));
  expect(groups.filter(row=>row.kind==='logs')).toHaveLength(20);
  expect(groups.some(row=>row.kind==='logs'&&logsFailed(row.events))).toBe(true);
  const html=renderToStaticMarkup(createElement(ChatRunLog,{events:buildWeek2Timeline(partial,tools)}));
  expect(html).toContain('Logs · Failed');expect(html).not.toMatch(/<details[^>]* open/);
  const full=await api('/'+session.id+'/events');
  const fullState=restoreHistory(emptySession(session),full);
  const dialogue=historicalContext({...fullState,contextEvents:[]},'no-run').filter(m=>m.role!=='system');
  expect(first.dialogueTokens.o200k_base).toBe((await estimateContextInput('gpt-4o-mini',dialogue)).estimatedInputTokens);
  // Snapshot excludes a new turn appended after opening.
  await manager.run({state,userText:'Turn 47: appended after snapshot.',onEvent});
  let merged=first.events,cursor=first.nextBefore,pages=1;
  while(cursor!==null){
   const page=await api(`/${session.id}/events?limit=20&before=${cursor}&snapshot=${first.snapshot}`);
   expect(page.accountingEvents).toBeUndefined();
   merged=mergeHistoryPages(merged,page.events);cursor=page.nextBefore;pages++;
  }
  expect(pages).toBe(3);expect(merged).toEqual(full);
  expect(new Set(merged.map((e:HistoryEvent)=>e.id)).size).toBe(merged.length);
  expect(restoreHistory(emptySession(session),merged).toolExecutions[0].status).toBe('incomplete');
  const contexts:string[]=[];
  await new ManagerAgent({complete:async({messages})=>{contexts.push(...messages.map(m=>m.content));return{text:'Follow-up uses full history.'}}},tools).run({state:fullState,userText:'Follow-up'});
  expect(contexts).toContain('Turn 1: saved dialogue.');expect(contexts).toContain('Turn 46: failed request.');
  expect((await api('/'+other.id+'/events?limit=20')).events).toEqual([]);
  for(const query of ['limit=0','limit=51','limit=20&before=bad','limit=20&snapshot=-1'])expect((await fetch(base+'/api/sessions/'+session.id+'/events?'+query)).status).toBe(400);
  await stop();await start();
  const reopened=await api('/'+session.id+'/events?limit=20');
  const reopenedHtml=renderToStaticMarkup(createElement(ChatRunLog,{events:buildWeek2Timeline(restoreHistory(emptySession(session),reopened.events),tools)}));
  expect(reopenedHtml).toContain('Logs · Failed');
  console.info(`History paging: 46 turns, 3 pages (20/20/6), ${first.events.length}/${full.length} events on opening; failure styling survives backend restart.`);
 }finally{if(server!?.listening)await stop();await rm(folder,{recursive:true,force:true});}
},20000);
