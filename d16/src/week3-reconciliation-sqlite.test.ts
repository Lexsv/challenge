import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { ManagerAgent, type ManagerLlmMessage } from './manager-agent';
import { HistoryWriter, type HistoryEvent } from './conversation-history';
import { emptySession } from './week3-session-api';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import { createBuiltInToolRegistry } from './tool-runtime';

it('persists the live-QA extractor identity only once through the Manager and SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-canonical-'));const path=join(dir,'test.sqlite');
  let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(path);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {
    await start();const session=await(await fetch(base,{method:'POST'})).json();
    const store={load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`Save ${response.status}`);return await response.json() as MemorySnapshot;}};
    const writer=new HistoryWriter(async(event:HistoryEvent)=>{const response=await fetch(`${base}/${session.id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});if(!response.ok)throw Error(`History ${response.status}`);return response.json();});
    const calls:string[]=[];
    const adapter={context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>''},complete:vi.fn(async({messages}:{messages:readonly ManagerLlmMessage[]})=>{
      if(messages[0].content.startsWith('Compare the current')){calls.push('reconcile');const input=JSON.parse(messages[1].content) as {current:string;existing:{subject:string;attribute:string}[]};const index=input.existing.findIndex(fact=>fact.subject==='Mark' && fact.attribute==='project deadline');return {text:JSON.stringify({action:'update',target:index,value:'December 2, 2026',evidence:input.current})};}
      calls.push('extract');const [source]=JSON.parse(messages[1].content) as ManagerLlmMessage[];const text=source.content;
      const updated=text.includes('revised');const subject=updated?"Mark's project deadline":text.startsWith('Alex')?'Alex':'Mark';const attribute=updated?'deadline':text.includes('release')?'release deadline':'project deadline';const value=updated?'December 2, 2026':text.includes('release')?'January 10, 2027':text.startsWith('Alex')?'November 20, 2026':'November 28, 2026';
      return {text:JSON.stringify({version:1,topic:{kind:"dialogue"},facts:[{subject,attribute,value,evidence:text,status:'confirmed',correction:updated}]})};
    })};
    const memory=new SessionMemory(store,new MemoryProcessor(adapter),'gpt-4o-mini');
    const manager=new ManagerAgent({complete:async()=>({text:'Noted.'})},createBuiltInToolRegistry());const state=emptySession(session);
    const first="Mark's project deadline is November 28, 2026.",update="Mark's project deadline has been revised to December 2, 2026.";
    for(const text of [first,update,update,"Mark's release deadline is January 10, 2027.","Alex's project deadline is November 20, 2026.",update]){
      const result=await manager.run({state,userText:text,sessionMemory:memory,onEvent:event=>writer.append(event)});expect(result.run.status).toBe('completed');
    }
    const userMessages=state.messages.filter(message=>message.role==='user');
    await stop();
    const db=new DatabaseSync(path,{readOnly:true});const row=db.prepare('SELECT data FROM week3_session_memory WHERE sessionId=?').get(session.id) as {data:string};const saved=JSON.parse(row.data);db.close();
    expect(saved.facts).toHaveLength(3);
    expect(saved.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({subject:'Mark',attribute:'project deadline',value:'December 2, 2026',sources:[userMessages[1].id,userMessages[2].id,userMessages[5].id],supersedes:[expect.objectContaining({value:'November 28, 2026',sources:[userMessages[0].id]})]}),
      expect.objectContaining({subject:'Mark',attribute:'release deadline',value:'January 10, 2027',sources:[userMessages[3].id]}),
      expect.objectContaining({subject:'Alex',attribute:'project deadline',value:'November 20, 2026',sources:[userMessages[4].id]}),
    ]));
    expect(calls.filter(call=>call==='extract')).toHaveLength(6);expect(calls.filter(call=>call==='reconcile')).toHaveLength(3);
    await start();expect((await store.load()).data?.facts).toEqual(saved.facts);
  } finally {if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
