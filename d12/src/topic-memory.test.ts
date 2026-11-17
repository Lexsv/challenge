import { expect, it, vi } from 'vitest';
import { applyTopicUpdate, extractTopicCandidates, topicSourcesFromArchive, type TopicCandidate } from './topic-memory';
import type { HistoryEvent } from './conversation-history';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';

const assess=async()=>({tokens:10,limit:10000});
const message=(id:string,role:'user'|'assistant',text:string,sequence:number,sessionId='session-a'):HistoryEvent=>({id:`event-${id}`,sessionId,sequence,type:'message',payload:{id,conversationId:sessionId,runId:'run',createdAt:1,role,type:'text',text}});
const reply=(topics:unknown[])=>({text:JSON.stringify({topics})});
const mockTopic=(evidence:unknown[],status='confirmed')=>({key:'Meeting',value:'16:00',status,evidence});

it('preserves archived user and assistant identities, roles, exact quotes and event order',async()=>{
  const events=[message('a','assistant','The meeting is at 16:00.',7),message('u','user','What time is the meeting?',3)];
  const complete=vi.fn().mockResolvedValue(reply([mockTopic([{sourceId:'a',quote:'16:00'},{sourceId:'u',quote:'meeting'},{sourceId:'a',quote:'16:00'}])]));
  const result=await extractTopicCandidates({complete,context:{assess,summarize:async()=>''}},'session-a',events);
  expect(topicSourcesFromArchive('session-a',events).map(source=>source.id)).toEqual(['u','a']);
  expect(result[0].evidence).toEqual([{messageId:'u',role:'user',sequence:3,quote:'meeting',existence:'verified'},{messageId:'a',role:'assistant',sequence:7,quote:'16:00',existence:'verified'}]);
  expect(result[0].assessment).toEqual({support:'unverified',change:'unverified'});expect(result[0].sources).toEqual(['u','a']);
  expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).map((source:{id:string})=>source.id)).toEqual(['u','a']);
  expect(await extractTopicCandidates({complete,context:{assess,summarize:async()=>''}},'session-a',events)).toEqual(result);
});

it.each([{sourceId:'missing',quote:'16:00'},{sourceId:'u',quote:'Agreed at 16:00'}])('rejects a missing source or incorrect quote',async evidence=>{
  const complete=vi.fn().mockResolvedValue(reply([mockTopic([evidence])]));
  await expect(extractTopicCandidates({complete,context:{assess,summarize:async()=>''}},'session-a',[message('u','user','Consider 16:00.',1)])).rejects.toThrow('unsupported evidence');
});

it('rejects other sessions, invalid sequences and duplicate archive identities before model dispatch',async()=>{
  const complete=vi.fn();const adapter={complete,context:{assess,summarize:async()=>''}};
  await expect(extractTopicCandidates(adapter,'session-a',[message('u','user','Hi',1,'session-b')])).rejects.toThrow('another session');
  await expect(extractTopicCandidates(adapter,'session-a',[message('u','user','Hi',0)])).rejects.toThrow('sequence');
  await expect(extractTopicCandidates(adapter,'session-a',[message('u','user','Hi',1),message('u','user','Hi',2)])).rejects.toThrow('identity');
  expect(complete).not.toHaveBeenCalled();
});

it.each(['Consider moving the meeting to 16:00.','We agreed to move the meeting to 16:00.'])('does not treat an exact quote as semantic confirmation: %s',async text=>{
  const complete=vi.fn().mockResolvedValue(reply([mockTopic([{sourceId:'u',quote:text}])]));
  const [candidate]=await extractTopicCandidates({complete,context:{assess,summarize:async()=>''}},'session-a',[message('u','user',text,1)]);
  expect(candidate.status).toBe('confirmed'); // This is the model's claim, not an assessment.
  expect(candidate.assessment).toEqual({support:'unverified',change:'unverified'});
  expect(()=>applyTopicUpdate([],{action:'new',candidate,archiveSequence:1},{sessionId:'session-a',events:[message('u','user',text,1)]})).toThrow('support has not been verified');
});

it('requires separate support and change confirmation before changing an existing record',()=>{
  const candidate:TopicCandidate={key:'Meeting',value:'13:00',status:'confirmed',sources:['one'],evidence:[{messageId:'one',role:'user',sequence:1,quote:'13:00',existence:'verified'}],assessment:{support:'supported',change:'unverified'}};
  const archive={sessionId:'session-a',events:[message('one','user','13:00',1),message('two','user','16:00',2)]};
  const initial=applyTopicUpdate([],{action:'new',candidate,archiveSequence:1},archive);
  const proposal={...candidate,value:'16:00',sources:['two'],evidence:[{messageId:'two',role:'user' as const,sequence:2,quote:'16:00',existence:'verified' as const}]};
  expect(()=>applyTopicUpdate(initial,{action:'change',targetKey:'Meeting',candidate:proposal,archiveSequence:2},archive)).toThrow('change has not been confirmed');
  const confirmed={...proposal,assessment:{support:'supported' as const,change:'confirmed' as const}};
  const updated=applyTopicUpdate(initial,{action:'change',targetKey:'Meeting',candidate:confirmed,archiveSequence:2},archive);
  expect(updated[0].history).toMatchObject([{value:'13:00',sources:['one'],changeSources:['two']}]);
  expect(applyTopicUpdate(updated,{action:'change',targetKey:'Meeting',candidate:confirmed,archiveSequence:2},archive)).toEqual(updated);
});

it('does not call the model when the input budget is exceeded',async()=>{
  const complete=vi.fn();await expect(extractTopicCandidates({complete,context:{assess:async()=>({tokens:100,limit:50}),summarize:async()=>''}},'session-a',[message('u','user','Hi',1)])).rejects.toThrow('input budget');expect(complete).not.toHaveBeenCalled();
});

it('uses message IDs and event sequences returned by the isolated Week 3 archive',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-topic-evidence-'));let server:ReturnType<typeof createSessionServer>|undefined;
  try {
    server=createSessionServer(join(dir,'archive.sqlite'));await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address || typeof address==='string')throw Error('No port');const base=`http://127.0.0.1:${address.port}/api/week3/sessions`;
    const session=await(await fetch(base,{method:'POST'})).json();const event=message('archived-user','user','Discuss World War I.',1,session.id);delete event.sequence;
    const response=await fetch(`${base}/${session.id}/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});expect(response.status).toBe(201);
    const archive=await(await fetch(`${base}/${session.id}/events`)).json() as HistoryEvent[];
    const complete=vi.fn().mockResolvedValue(reply([{key:'World War I',value:'Discussion of World War I',status:'confirmed',evidence:[{sourceId:'archived-user',quote:'World War I'}]}]));
    const [candidate]=await extractTopicCandidates({complete,context:{assess,summarize:async()=>''}},session.id,archive);
    expect(candidate.evidence).toEqual([{messageId:'archived-user',role:'user',sequence:1,quote:'World War I',existence:'verified'}]);
    expect(candidate.assessment.support).toBe('unverified');
  } finally {if(server?.listening)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});
