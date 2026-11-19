import type { AppResult } from './app-result.ts';
import type { MemoryPreparationEvidence, PreparationBoundaryError } from './memory-preparation-evidence.ts';
import type { MemorySnapshot } from './session-memory';
import type { ManagerLlmMessage } from './manager-agent';

/** An injected trusted reader must obtain this view from one consistent read; no production adapter exists. */
export type EvidenceArchiveEvent = { id:string; sessionId:string; sequence:number; groupId?:string; messageId?:string; message?:ManagerLlmMessage; toolResultId?:string };
export type EvidenceSourceView = {
  sessionId:string | null;
  snapshot:MemorySnapshot | null | undefined; // null = confirmed missing, undefined = unavailable
  events:readonly EvidenceArchiveEvent[];
  /** Complete event range supplied by the trusted reader, not inferred from the array. */
  boundary?:{first:number;last:number};
  /** A source-provided atomic read stamp binds both source versions, when available. */
  consistent?:{snapshotRevision:number;archiveThrough:number};
  /** Trusted reader confirms this range covers the pending groups and required tool results. */
  coversPending?:true;
  requiredToolCallIds?:readonly string[];
  /** A persistent archive reader explicitly confirms committed retention through this sequence. */
  durableThrough?:number;
};
export type EvidenceSource = { read(sessionId:string):Promise<AppResult<EvidenceSourceView,PreparationBoundaryError>> };

const unknownError:PreparationBoundaryError={code:'unknown',category:'unknown',operation:'load',phase:'unknown',transaction:'unknown'};
const unknown = () => ({state:'unknown'} as const);

/** Produces evidence only. The reader is a trust boundary; this does not authenticate its claims. */
export async function produceMemoryEvidence(expectedId:string, source:EvidenceSource):Promise<AppResult<MemoryPreparationEvidence,PreparationBoundaryError>> {
  let result:AppResult<EvidenceSourceView,PreparationBoundaryError>;
  try { result=await source.read(expectedId); } catch { return {ok:false,error:{...unknownError}}; }
  if(!result.ok) {const {code,category,operation,phase,transaction}=result.error;return {ok:false,error:{code,category,operation,phase,transaction}};}
  const view=result.data;
  const evidence:MemoryPreparationEvidence={session:unknown(),snapshot:unknown(),archiveCoverage:unknown(),pendingGroups:unknown(),orderingAndContinuity:unknown(),toolObservations:unknown(),durableRetention:unknown(),failure:null};
  if(view.sessionId===null) {evidence.session={state:'missing'};return {ok:true,data:evidence};}
  if(!view.sessionId || !expectedId) return {ok:true,data:evidence};
  evidence.session={state:'verified',value:{expectedId,actualId:view.sessionId},source:'session_archive'};
  if(view.sessionId!==expectedId) return {ok:true,data:evidence};
  if(view.snapshot===null) evidence.snapshot={state:'missing'};
  else if(view.snapshot && Number.isSafeInteger(view.snapshot.revision) && view.snapshot.revision>=0) evidence.snapshot={state:'verified',value:{sessionId:expectedId,revision:view.snapshot.revision},source:'memory_store'};

  const boundary=view.boundary, events=view.events;
  const rangeValid=!!boundary && Number.isSafeInteger(boundary.first) && boundary.first>=1 && Number.isSafeInteger(boundary.last) && boundary.last>=boundary.first;
  const ids=new Set<string>(); const messages=new Set<string>();
  const valid=rangeValid && events.length===boundary!.last-boundary!.first+1 && events.every((event,index)=>{
    if(!event.id || ids.has(event.id) || event.sessionId!==expectedId || event.sequence!==boundary!.first+index || (event.message && (!event.messageId || messages.has(event.messageId)))) return false;
    ids.add(event.id);
    if(event.messageId && event.message) messages.add(event.messageId);
    return true;
  });
  if(!valid) return {ok:true,data:evidence};
  const range={sessionId:expectedId,firstSequence:boundary!.first,lastSequence:boundary!.last};
  evidence.archiveCoverage={state:'verified',value:range,source:'session_archive'};
  if(Number.isSafeInteger(view.durableThrough) && view.durableThrough!>=boundary!.last) evidence.durableRetention={state:'verified',value:{sessionId:expectedId,throughSequence:view.durableThrough!},source:'session_archive'};
  const consistent=view.snapshot && view.consistent && view.consistent.snapshotRevision===view.snapshot.revision && view.consistent.archiveThrough===boundary!.last;
  if(!consistent) return {ok:true,data:evidence};
  if(view.snapshot!.data) {
    const groups=view.snapshot!.data.buffer;
    let previousSequence=boundary!.first-1;
    const matches=groups.every(group=>{
      const archived=events.filter(event=>event.groupId===group.id && event.message);
      if(!archived.length || archived[0].sequence<=previousSequence) return false;
      previousSequence=archived.at(-1)!.sequence;
      return archived.length===group.messages.length && archived.every((event,index)=>JSON.stringify(event.message)===JSON.stringify(group.messages[index]));
    });
    evidence.pendingGroups=matches && view.coversPending ? {state:'verified',value:structuredClone(groups),source:'session_archive'} : !matches && view.coversPending ? {state:'missing'} : unknown();
    if(matches && view.coversPending) evidence.orderingAndContinuity={state:'verified',value:range,source:'session_archive'};
  }
  if(view.requiredToolCallIds) {
    const required=[...view.requiredToolCallIds],available=events.flatMap(event=>event.toolResultId?[event.toolResultId]:[]);
    evidence.toolObservations=required.every(id=>available.includes(id)) ? {state:'verified',value:{requiredCallIds:required,availableCallIds:available},source:'session_archive'} : view.coversPending ? {state:'missing'} : unknown();
  }
  return {ok:true,data:evidence};
}
