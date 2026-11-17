import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { createTopicLifecycle } from './topic-lifecycle';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { TopicCandidate } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

it('refuses mock model activation in production before opening a database',()=>{
  const result=spawnSync(process.execPath,['server/sessions.mjs','--topic-mock','--db',join(tmpdir(),'d11-production-mock-must-not-exist.sqlite')],{cwd:process.cwd(),env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_ENV:'production'},encoding:'utf8'});
  expect(result.status).not.toBe(0);expect(result.stderr).toContain('unavailable in production');
});

it('runs the browser-style hook through HTTP, preserves failed buffers, and skips completed segments after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-http-topics-'));const dbPath=join(dir,'db.sqlite');let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const assess=vi.fn().mockRejectedValueOnce(Error('synthetic failure')).mockImplementation(async events=>{
    expect(events.map((e:{payload:{text:string}})=>e.payload.text)).toEqual(['Actual archived user content.','Actual archived assistant reply.']);
    const candidate:TopicCandidate={key:'Topic',value:'Actual archived user content.',status:'confirmed',sources:['u'],evidence:[{messageId:'u',role:'user',sequence:1,quote:'Actual archived user content.',existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};
    const assessment:SemanticAssessment={classification:'fact',factSupported:true,changeConfirmed:false,evidence:[{messageId:'u',quote:'Actual archived user content.'}]};return [{candidate,assessment}];
  });
  const start=async()=>{server=createSessionServer(dbPath,{topicProcess:async(repo,sessionId,runId)=>createTopicLifecycle(repo,sessionId,assess)([{id:runId,messages:[]}])});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {
    await start();const a=await(await fetch(base,{method:'POST'})).json(),b=await(await fetch(base,{method:'POST'})).json();
    expect(await(await fetch(`${base}/${a.id}/topic-mode`)).json()).toEqual({enabled:true});
    for(const [id,role,text] of [['u','user','Actual archived user content.'],['v','assistant','Actual archived assistant reply.']] as const){const event={id:`event-${id}`,sessionId:a.id,type:'message',payload:{id,conversationId:a.id,runId:'run-1',createdAt:1,role,type:'text',text}};expect((await fetch(`${base}/${a.id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)})).status).toBe(201);}
    const post=async(sessionId:string,body:unknown)=>fetch(`${base}/${sessionId}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    expect((await post(a.id,{runId:'run-1',content:'forged'})).status).toBe(400);expect((await post(b.id,{runId:'run-1'})).status).toBe(404);
    const store={load:async()=>await(await fetch(`${base}/${a.id}/memory`)).json() as MemorySnapshot,save:async(snapshot:MemorySnapshot)=>{const response=await fetch(`${base}/${a.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});if(!response.ok)throw Error('save failed');return await response.json() as MemorySnapshot;}};
    let simulateHttpFailure=false;
    const hook=async(groups:readonly {id:string}[])=>{for(const group of groups){if(simulateHttpFailure)await fetch('http://127.0.0.1:1/unavailable');const response=await post(a.id,{runId:group.id});if(!response.ok)throw Error('Topic processing failed.');}};
    const processor=new MemoryProcessor({complete:async()=>({text:'{"facts":[]}'}),context:{assess:async()=>({tokens:1,limit:10000}),summarize:async()=>''}});const compress=vi.spyOn(processor,'compress').mockResolvedValue('Summary.');
    const memory=new SessionMemory(store,processor,'gpt-4o-mini',60,hook);const group={id:'run-1',sourceIds:['u'],messages:[{role:'user' as const,content:'untrusted '.repeat(100)}]};
    simulateHttpFailure=true;await expect(memory.prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow();expect(compress).not.toHaveBeenCalled();expect((await store.load()).data?.buffer).toHaveLength(1);simulateHttpFailure=false;
    await expect(memory.prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow('Topic processing failed');expect(compress).not.toHaveBeenCalled();expect((await store.load()).data?.buffer).toHaveLength(1);
    await stop();await start();await memory.prepare([group],[{role:'user',content:'Next?'}],'next');expect(compress).toHaveBeenCalledTimes(1);expect((await store.load()).data?.covered).toContain('run-1');
    const again=await post(a.id,{runId:'run-1'});const beforeRestart=await again.json();expect(beforeRestart).toMatchObject({status:'already_completed'});expect(assess).toHaveBeenCalledTimes(2);
    await stop();await start();const restored=await post(a.id,{runId:'run-1'});expect(await restored.json()).toMatchObject({status:'already_completed',segmentId:beforeRestart.segmentId});expect(assess).toHaveBeenCalledTimes(2);
  } finally {if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});

it('explicitly disables the endpoint when no mock processor is configured',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-topic-disabled-'));let server:ReturnType<typeof createSessionServer>|undefined;
  try{server=createSessionServer(join(dir,'db.sqlite'));await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');const base=`http://127.0.0.1:${address.port}/api/week3/sessions`;const session=await(await fetch(base,{method:'POST'})).json();expect(await(await fetch(`${base}/${session.id}/topic-mode`)).json()).toEqual({enabled:false});expect((await fetch(`${base}/${session.id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run-1'})})).status).toBe(503);}finally{if(server?.listening)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});

it('commits one marker for concurrent duplicate HTTP requests',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-topic-race-'));const path=join(dir,'db.sqlite');let server:ReturnType<typeof createSessionServer>|undefined;
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered=0;
  try{server=createSessionServer(path,{topicProcess:async(repo,sessionId,runId)=>createTopicLifecycle(repo,sessionId,async()=>{entered++;if(entered===2)release();await gate;return []; })([{id:runId,messages:[]}])});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');const base=`http://127.0.0.1:${address.port}/api/week3/sessions`;const session=await(await fetch(base,{method:'POST'})).json();
    const event={id:'event-u',sessionId:session.id,type:'message',payload:{id:'u',conversationId:session.id,runId:'r',createdAt:1,role:'user',type:'text',text:'Synthetic message.'}};expect((await fetch(`${base}/${session.id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)})).status).toBe(201);
    const post=()=>fetch(`${base}/${session.id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'r'})});const responses=await Promise.all([post(),post()]);expect(responses.map(response=>response.status)).toEqual([200,200]);
    await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));const db=new DatabaseSync(path,{readOnly:true});try{expect(db.prepare('SELECT COUNT(*) AS count FROM week3_topic_segments WHERE session_id=?').get(session.id)).toMatchObject({count:1});}finally{db.close();}
  }finally{if(server?.listening)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});

it('starts the standard backend in explicit isolated mock mode and persists a synthetic topic',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-cli-mock-'));const path=join(dir,'db.sqlite');
  const child=spawn(process.execPath,['server/sessions.mjs','--topic-mock','--db',path,'--port','0'],{cwd:process.cwd(),env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  try {
    const port=await new Promise<number>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Mock backend startup timed out')),5000);child.once('error',reject);child.stdout.on('data',chunk=>{text+=chunk.toString();const match=text.match(/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Mock backend exited before startup'));});});
    const base=`http://127.0.0.1:${port}/api/week3/sessions`;const session=await(await fetch(base,{method:'POST'})).json();expect(await(await fetch(`${base}/${session.id}/topic-mode`)).json()).toEqual({enabled:true,mockModel:true,failSummary:false});
    const event={id:'event-u',sessionId:session.id,type:'message',payload:{id:'u',conversationId:session.id,runId:'r',createdAt:1,role:'user',type:'text',text:'QA_TOPIC: Synthetic decision'}};
    expect((await fetch(`${base}/${session.id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)})).status).toBe(201);
    await writeFile(path+'.fail-summary','');expect(await(await fetch(`${base}/${session.id}/topic-mode`)).json()).toMatchObject({failSummary:true});await unlink(path+'.fail-summary');
    const post=()=>fetch(`${base}/${session.id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'r'})});
    await writeFile(path+'.fail-topic','');expect((await post()).ok).toBe(false);await unlink(path+'.fail-topic');
    const result=await post();expect(await result.json()).toMatchObject({status:'completed'});
    child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    const db=new DatabaseSync(path,{readOnly:true});try{expect(db.prepare('SELECT value FROM week3_topics WHERE session_id=?').get(session.id)).toMatchObject({value:'Synthetic decision'});expect(db.prepare('SELECT COUNT(*) AS count FROM week3_topic_segments WHERE session_id=?').get(session.id)).toMatchObject({count:1});}finally{db.close();}
  } finally {if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}await rm(dir,{recursive:true,force:true});}
});
