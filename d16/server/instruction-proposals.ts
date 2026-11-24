import { randomBytes } from 'node:crypto';
import type { PersonalizationSnapshot } from '../src/week3-session-api.ts';
import type { InstructionDetectorResult } from '../src/persistent-instruction-detector.ts';

export type PendingInstructionProposal = Readonly<{
  sessionId:string;runId:string;messageId:string;userMessage:string;
  snapshot:PersonalizationSnapshot;
  detectorResult:Extract<InstructionDetectorResult,{ok:true}>;
  proposedHabits:string;
}>;

/** Local in-memory one-shot proposals; identifiers are not authentication. */
export function createInstructionProposalStore(options:{now?:()=>number;ttlMs?:number;maxEntries?:number}={}) {
  const now=options.now ?? (()=>performance.now()), ttl=options.ttlMs ?? 15*60_000, max=options.maxEntries ?? 256;
  if(!Number.isSafeInteger(ttl) || ttl<1 || ttl>24*60*60_000 || !Number.isSafeInteger(max) || max<1 || max>1000) throw new Error('Invalid proposal store configuration.');
  const entries=new Map<string,{proposal:PendingInstructionProposal;expiresAt:number}>();
  const sessions=new Map<string,string>();
  const remove=(id:string)=>{const entry=entries.get(id);if(entry){entries.delete(id);sessions.delete(entry.proposal.sessionId);}};
  const sweep=(time:number)=>{for(const [id,entry] of entries)if(time>=entry.expiresAt)remove(id);};
  return {
    create(proposal:PendingInstructionProposal):{ok:true;id:string;expiresInMs:number}|{ok:false;error:'duplicate'|'capacity'|'unavailable'} {
      const time=now();if(!Number.isFinite(time))return {ok:false,error:'unavailable'};
      sweep(time);
      if(sessions.has(proposal.sessionId))return {ok:false,error:'duplicate'};
      if(entries.size>=max)return {ok:false,error:'capacity'};
      for(let attempt=0;attempt<3;attempt++){
        const id=randomBytes(32).toString('base64url');
        if(!entries.has(id)){entries.set(id,{proposal:Object.freeze({...proposal}),expiresAt:time+ttl});sessions.set(proposal.sessionId,id);return {ok:true,id,expiresInMs:ttl};}
      }
      return {ok:false,error:'unavailable'};
    },
    claim(id:string,sessionId:string):{ok:true;proposal:PendingInstructionProposal}|{ok:false;error:'expired'|'not_found'|'mismatch'} {
      const time=now();if(!Number.isFinite(time))return {ok:false,error:'not_found'};
      const entry=entries.get(id);
      if(entry && time>=entry.expiresAt){remove(id);sweep(time);return {ok:false,error:'expired'};}
      sweep(time);
      if(!entry)return {ok:false,error:'not_found'};
      if(entry.proposal.sessionId!==sessionId)return {ok:false,error:'mismatch'};
      remove(id);return {ok:true,proposal:entry.proposal};
    },
    size(){const time=now();if(Number.isFinite(time))sweep(time);return entries.size;},
  };
}
