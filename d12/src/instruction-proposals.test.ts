import { describe,expect,it } from 'vitest';
import { createInstructionProposalStore, type PendingInstructionProposal } from '../server/instruction-proposals';

function proposal(sessionId:string):PendingInstructionProposal {
  return {sessionId,runId:'run',messageId:'message',userMessage:'Always use examples.',snapshot:{sessionId,profileId:'profile',profileRevision:1,habits:''},detectorResult:{ok:true,operations:[{action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'}]},proposedHabits:'* Use examples.'};
}

describe('in-memory instruction proposal store',()=>{
  it('preserves object identity, rejects duplicates, and binds claims to sessions',()=>{
    const store=createInstructionProposalStore(), original=proposal('a'), created=store.create(original);
    expect(created.ok).toBe(true);if(!created.ok)throw Error('fixture');
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.create(original)).toEqual({ok:false,error:'duplicate'});
    expect(store.claim(created.id,'other')).toEqual({ok:false,error:'mismatch'});
    const claimed=store.claim(created.id,'a');expect(claimed.ok).toBe(true);
    if(claimed.ok)expect(claimed.proposal.detectorResult).toBe(original.detectorResult);
    expect(store.claim(created.id,'a')).toEqual({ok:false,error:'not_found'});
  });
  it('bounds capacity and removes expired entries',()=>{
    let time=0;const store=createInstructionProposalStore({now:()=>time,ttlMs:10,maxEntries:1});
    const first=store.create(proposal('a'));expect(first.ok).toBe(true);
    expect(store.create(proposal('b'))).toEqual({ok:false,error:'capacity'});
    time=10;
    if(first.ok)expect(store.claim(first.id,'a')).toEqual({ok:false,error:'expired'});
    expect(store.size()).toBe(0);expect(store.create(proposal('b')).ok).toBe(true);
    expect(createInstructionProposalStore().size()).toBe(0);
  });
});
