import { describe, expect, it } from 'vitest';
import { produceMemoryEvidence, type EvidenceSourceView } from './memory-evidence-producer.ts';
import type { MemorySnapshot } from './session-memory';

const snapshot:MemorySnapshot={revision:2,data:{summary:'',facts:[],covered:[],extracted:[],short:[],buffer:[{id:'run',messages:[{role:'user',content:'hello'}]}]}};
const view=():EvidenceSourceView=>({sessionId:'s',snapshot:structuredClone(snapshot),events:[{id:'e1',sessionId:'s',sequence:1,groupId:'run',messageId:'m1',message:{role:'user',content:'hello'}},{id:'e2',sessionId:'s',sequence:2,toolResultId:'call'}],boundary:{first:1,last:2},consistent:{snapshotRevision:2,archiveThrough:2},coversPending:true,requiredToolCallIds:['call'],durableThrough:2});
const produce=(data:EvidenceSourceView)=>produceMemoryEvidence('s',{read:async()=>({ok:true,data})});
const evidence=async(data:EvidenceSourceView)=>{const r=await produce(data);if(!r.ok)throw Error('unexpected failure');return r.data;};

describe('isolated evidence producer with synthetic trusted source',()=>{
  it('verifies the bounded, consistent fixture and leaves the source unmodified',async()=>{
    const data=view(),before=structuredClone(data),result=await evidence(data);
    for(const name of ['session','snapshot','archiveCoverage','pendingGroups','orderingAndContinuity','toolObservations','durableRetention'] as const) expect(result[name].state).toBe('verified');
    expect(data).toEqual(before);
  });
  it('represents missing, unknown and mismatched session identities',async()=>{
    expect((await evidence({...view(),sessionId:null})).session.state).toBe('missing');
    expect((await evidence({...view(),sessionId:''})).session.state).toBe('unknown');
    const mismatch=await evidence({...view(),sessionId:'other'});
    expect(mismatch.session).toMatchObject({state:'verified',value:{expectedId:'s',actualId:'other'}});
    expect(mismatch.archiveCoverage.state).toBe('unknown');
  });
  it('distinguishes missing snapshot and unavailable snapshot',async()=>{
    expect((await evidence({...view(),snapshot:null})).snapshot.state).toBe('missing');
    expect((await evidence({...view(),snapshot:undefined})).snapshot.state).toBe('unknown');
  });
  it('does not infer coverage from events without an authoritative boundary',async()=>{
    expect((await evidence({...view(),boundary:undefined})).archiveCoverage.state).toBe('unknown');
  });
  it('rejects missing, duplicated and out-of-order archive events or message identities',async()=>{
    const original=view();
    for(const events of [[original.events[0]], [original.events[0],original.events[0]], [...original.events].reverse(), [original.events[0],{...original.events[1],messageId:'m1',message:{role:'user' as const,content:'other'}}]]) {
      expect((await evidence({...original,events})).archiveCoverage.state).toBe('unknown');
    }
  });
  it('does not verify pending groups after source mismatch or without a consistent read',async()=>{
    const data=view();data.snapshot!.data!.buffer[0].messages[0].content='different';
    expect((await evidence(data)).pendingGroups.state).toBe('missing');
    expect((await evidence({...view(),consistent:undefined})).pendingGroups.state).toBe('unknown');
    const stale=await evidence({...view(),consistent:{snapshotRevision:3,archiveThrough:2}});
    expect(stale.pendingGroups.state).toBe('unknown');expect(stale.orderingAndContinuity.state).toBe('unknown');
  });
  it('reports missing or unknown tool observations and does not infer durability',async()=>{
    expect((await evidence({...view(),requiredToolCallIds:['absent']})).toolObservations.state).toBe('missing');
    expect((await evidence({...view(),requiredToolCallIds:undefined})).toolObservations.state).toBe('unknown');
    expect((await evidence({...view(),durableThrough:undefined})).durableRetention.state).toBe('unknown');
  });
  it('preserves structured failures and treats thrown transport errors as unknown',async()=>{
    const error={code:'unknown',category:'server',operation:'load',phase:'archive',transaction:'unknown'} as const;
    const failed=await produceMemoryEvidence('s',{read:async()=>({ok:false,error})});
    expect(failed).toEqual({ok:false,error});
    const thrown=await produceMemoryEvidence('s',{read:async()=>{throw Error('sensitive details');}});
    expect(thrown).toMatchObject({ok:false,error:{category:'unknown',transaction:'unknown'}});
    expect(JSON.stringify(thrown)).not.toContain('sensitive');
  });
});
