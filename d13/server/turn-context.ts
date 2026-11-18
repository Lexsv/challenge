import { randomBytes } from 'node:crypto';
import type { PersonalizationSnapshot } from '../src/week3-session-api.ts';

type References = Readonly<{sessionId:string;runId:string;messageId:string}>;
type SnapshotResolution = {ok:true;data:PersonalizationSnapshot}|{ok:false;error:string};
type TurnContext = Readonly<References & {snapshot:PersonalizationSnapshot}>;
type CreateResult = {ok:true;token:string;snapshot:PersonalizationSnapshot}|{ok:false;error:'invalid_reference'|'unavailable'|'capacity'|'duplicate'};
type ConsumeResult = {ok:true;context:TurnContext}|{ok:false;error:'invalid_reference'|'not_found'|'expired'|'mismatch'};
type Entry = {context:TurnContext;expiresAt:number};

const referencePattern=/^[a-zA-Z0-9-]{1,100}$/;
const isReferences=(value:References) => !!value && [value.sessionId,value.runId,value.messageId].every(item=>typeof item==='string' && referencePattern.test(item));

/** In-process consistency aid, not authentication or proof that a client used a snapshot. */
export function createTurnContextStore(options:{resolve:(sessionId:string)=>SnapshotResolution;now?:()=>number;ttlMs?:number;maxEntries?:number}) {
  const ttlMs=options.ttlMs ?? 15*60_000, maxEntries=options.maxEntries ?? 256;
  if (!Number.isSafeInteger(ttlMs) || ttlMs<1 || ttlMs>24*60*60_000 || !Number.isSafeInteger(maxEntries) || maxEntries<1 || maxEntries>1000) throw new Error('Invalid turn context store configuration.');
  const now=options.now ?? (()=>performance.now());
  const entries=new Map<string,Entry>();
  const bindings=new Map<string,number>();
  const sweep=(time:number)=>{for(const [token,entry] of entries)if(time>=entry.expiresAt)entries.delete(token);for(const [key,expiresAt] of bindings)if(time>=expiresAt)bindings.delete(key);};
  return {
    create(refs:References):CreateResult {
      if (!isReferences(refs) || Object.keys(refs).some(key=>!['sessionId','runId','messageId'].includes(key))) return {ok:false,error:'invalid_reference'};
      const time=now();
      if (!Number.isFinite(time)) return {ok:false,error:'unavailable'};
      sweep(time);
      const binding=JSON.stringify([refs.sessionId,refs.runId,refs.messageId]);
      if(bindings.has(binding))return {ok:false,error:'duplicate'};
      if (bindings.size>=maxEntries) return {ok:false,error:'capacity'};
      try {
        const resolved=options.resolve(refs.sessionId);
        if (!resolved.ok) return {ok:false,error:'unavailable'};
        const value=resolved.data;
        if (!value || value.sessionId!==refs.sessionId || typeof value.profileId!=='string' || !value.profileId.trim() || value.profileId!==value.profileId.trim() || !Number.isSafeInteger(value.profileRevision) || value.profileRevision<1 || typeof value.habits!=='string' || value.habits.length>50000 || (value.profileId==='general' && value.habits!=='')) return {ok:false,error:'unavailable'};
        const snapshot=Object.freeze({sessionId:value.sessionId,profileId:value.profileId,profileRevision:value.profileRevision,habits:value.habits});
        const context=Object.freeze({sessionId:refs.sessionId,runId:refs.runId,messageId:refs.messageId,snapshot});
        let token='';
        for(let attempt=0;attempt<3;attempt++){const candidate=randomBytes(32).toString('base64url');if(!entries.has(candidate)){token=candidate;break;}}
        if (!token) return {ok:false,error:'unavailable'};
        entries.set(token,{context,expiresAt:time+ttlMs});
        bindings.set(binding,time+ttlMs);
        return {ok:true,token,snapshot};
      } catch {return {ok:false,error:'unavailable'};}
    },
    consume(token:string,refs:References):ConsumeResult {
      if (!isReferences(refs) || Object.keys(refs).some(key=>!['sessionId','runId','messageId'].includes(key)) || typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return {ok:false,error:'invalid_reference'};
      const time=now();
      if (!Number.isFinite(time)) return {ok:false,error:'not_found'};
      const entry=entries.get(token);
      if (entry && time>=entry.expiresAt) {entries.delete(token);sweep(time);return {ok:false,error:'expired'};}
      sweep(time);
      if (!entry) return {ok:false,error:'not_found'};
      const {context}=entry;
      if (context.sessionId!==refs.sessionId || context.runId!==refs.runId || context.messageId!==refs.messageId) return {ok:false,error:'mismatch'};
      entries.delete(token);
      return {ok:true,context};
    },
    size():number {const time=now();if(Number.isFinite(time))sweep(time);return entries.size;},
  };
}
