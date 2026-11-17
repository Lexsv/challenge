import type { ManagerLlmAdapter, ManagerLlmMessage } from './manager-agent';
import type { RequestMeter } from './token-meter';
import type { HistoryEvent } from './conversation-history';

export type TopicSource = { id:string; role:'user'|'assistant'; sequence:number; content:string };
export type TopicEvidence = {messageId:string; role:'user'|'assistant'; sequence:number; quote:string; existence:'verified'};
export type TopicCandidate = { key:string; value:string; status:'confirmed'|'uncertain'|'rejected'; sources:string[]; evidence:TopicEvidence[]; assessment:{support:'unverified'|'supported';change:'unverified'|'confirmed'} };
export type TopicHistoryEntry = {value:string; sources:string[]; archiveSequence:number|null; kind:'change'|'correction'; changeSources:string[]; changeSequence:number|null};
export type TopicRecord = {key:string; value:string; status:TopicCandidate['status']; sources:string[]; archiveSequence:number|null; history:TopicHistoryEntry[]};
export type TopicUpdate = {action:'new'|'enrich'|'confirm'|'change'|'correction'|'ambiguous'; targetKey?:string; candidate:TopicCandidate; archiveSequence:number|null};

/** Apply an already-classified update. Unknown chronology remains explicitly unknown. */
export function applyTopicUpdate(records:readonly TopicRecord[], update:TopicUpdate, archive:{sessionId:string;events:readonly HistoryEvent[]}):TopicRecord[] {
  const out=structuredClone(records) as TopicRecord[];
  if(update.archiveSequence!==null && (!Number.isSafeInteger(update.archiveSequence) || update.archiveSequence<1))throw new Error('Invalid archive sequence.');
  const norm=(text:string)=>text.trim().toLocaleLowerCase();
  const target=update.targetKey ? out.filter(record=>norm(record.key)===norm(update.targetKey!)) : [];
  if(update.action==='ambiguous')return out;
  const sources=new Map(topicSourcesFromArchive(archive.sessionId,archive.events).map(source=>[source.id,source]));
  if(!update.candidate.evidence.length || !update.candidate.sources.length || update.candidate.evidence.some(item=>{const source=sources.get(item.messageId);return item.existence!=='verified' || !item.quote.trim() || !source || source.role!==item.role || source.sequence!==item.sequence || !source.content.includes(item.quote);}) || update.candidate.sources.some(id=>!update.candidate.evidence.some(item=>item.messageId===id)) || update.candidate.evidence.some(item=>!update.candidate.sources.includes(item.messageId)))throw new Error('Topic update requires valid source evidence.');
  if(update.candidate.assessment.support!=='supported')throw new Error('Topic evidence support has not been verified.');
  if((update.action==='change' || update.action==='correction') && update.candidate.assessment.change!=='confirmed')throw new Error('Topic change has not been confirmed.');
  if(update.action==='new') {
    if(out.some(record=>norm(record.key)===norm(update.candidate.key)))throw new Error('Topic already exists.');
    out.push({key:update.candidate.key,value:update.candidate.value,status:update.candidate.status,sources:[...new Set(update.candidate.sources)],archiveSequence:update.archiveSequence,history:[]});return out;
  }
  if(target.length!==1)throw new Error('Topic target is missing or ambiguous.');
  const record=target[0],candidate=update.candidate;
  if(candidate.sources.every(source=>record.sources.includes(source) || record.history.some(item=>item.sources.includes(source))))return out;
  if(candidate.status!=='confirmed')return out;
  if(update.action==='confirm' && norm(candidate.value)!==norm(record.value))throw new Error('Confirmation does not match the current topic value.');
  if(update.action==='confirm' || norm(candidate.value)===norm(record.value)){
    record.sources=[...new Set([...record.sources,...candidate.sources])];return out;
  }
  if(update.action==='enrich') {
    record.value=candidate.value;record.sources=[...new Set([...record.sources,...candidate.sources])];return out;
  }
  if(update.action==='change' || update.action==='correction') {
    if(record.archiveSequence!==null && update.archiveSequence!==null && update.archiveSequence<=record.archiveSequence)throw new Error('Topic update does not follow the current source.');
    record.history.push({value:record.value,sources:[...record.sources],archiveSequence:record.archiveSequence,kind:update.action,changeSources:[...new Set(candidate.sources)],changeSequence:update.archiveSequence});
    record.value=candidate.value;record.status=candidate.status;record.sources=[...new Set(candidate.sources)];record.archiveSequence=update.archiveSequence;
  }
  return out;
}

/** Build extraction inputs only from a single session's sequenced archive events. */
export function topicSourcesFromArchive(sessionId:string, events:readonly HistoryEvent[]):TopicSource[] {
  if(!sessionId.trim())throw new Error('Session ID is required.');
  const seenMessages=new Set<string>(),seenSequences=new Set<number>();const sources:TopicSource[]=[];
  for(const event of events){
    if(event.sessionId!==sessionId)throw new Error('Archive event belongs to another session.');
    if(!Number.isSafeInteger(event.sequence) || event.sequence!<1 || seenSequences.has(event.sequence!))throw new Error('Invalid archive event sequence.');
    seenSequences.add(event.sequence!);
    if(event.type!=='message' || (event.payload.role!=='user' && event.payload.role!=='assistant'))continue;
    if(event.payload.conversationId!==sessionId || !event.payload.id || seenMessages.has(event.payload.id))throw new Error('Invalid archived message identity.');
    seenMessages.add(event.payload.id);
    sources.push({id:event.payload.id,role:event.payload.role,sequence:event.sequence!,content:event.payload.text});
  }
  return sources.sort((a,b)=>a.sequence-b.sequence);
}

/** Exact quotes prove existence, not semantic support or confirmation. */
export async function extractTopicCandidates(adapter:ManagerLlmAdapter, sessionId:string, events:readonly HistoryEvent[], onMeter?: (meter:RequestMeter)=>Promise<void>):Promise<TopicCandidate[]> {
  const sources=topicSourcesFromArchive(sessionId,events);
  if(!sources.length)return [];
  if(!adapter.context)throw new Error('Topic extraction requires a model input estimator.');
  if(new Set(sources.map(source=>source.id)).size!==sources.length || sources.some(source=>!source.id || !source.content.trim()))throw new Error('Invalid topic source messages.');
  const messages:ManagerLlmMessage[]=[{role:'system',content:'Extract meaningful session knowledge from original user and assistant messages. Return JSON {"topics":[{"key":"short stable topic","value":"compact useful details","status":"confirmed|uncertain|rejected","evidence":[{"sourceId":"message ID","quote":"exact source quote"}]}]}. Include discussion topics, significant decisions, agreements, corrections and cancellations. Ignore greetings, acknowledgements and conversational noise. Do not infer confirmation from suggestions or uncertainty, or claim an external action succeeded without evidence. Use both roles as discussion sources; distinguish an assistant explanation from a user-confirmed decision. Do not invent missing information. Return an empty topics array when nothing meaningful is present.'},{role:'user',content:JSON.stringify(sources)}];
  const estimate=await adapter.context.assess(messages,[]);const limit=estimate.modelInputBudget ?? estimate.limit;
  if(estimate.tokens===undefined || limit===undefined || estimate.tokens>limit)throw new Error('Topic extraction exceeds the model input budget.');
  const response=await adapter.complete({messages,tools:[],onMeter:onMeter ? meter=>onMeter({...meter,requestKind:'extraction'}) : undefined});
  let parsed:unknown;try{parsed=JSON.parse(response.text ?? '');}catch{throw new Error('Topic extraction returned invalid JSON.');}
  if(response.toolCalls?.length || !parsed || typeof parsed!=='object' || !Array.isArray((parsed as {topics?:unknown}).topics))throw new Error('Topic extraction returned an invalid result.');
  const sourceMap=new Map(sources.map(source=>[source.id,source]));
  return (parsed as {topics:unknown[]}).topics.map(item=>{
    if(!item || typeof item!=='object' || Array.isArray(item))throw new Error('Topic extraction returned an invalid topic.');
    const topic=item as Record<string,unknown>;
    if(typeof topic.key!=='string' || !topic.key.trim() || typeof topic.value!=='string' || !topic.value.trim() || !['confirmed','uncertain','rejected'].includes(topic.status as string) || !Array.isArray(topic.evidence) || !topic.evidence.length)throw new Error('Topic extraction returned an invalid topic.');
    const evidence:TopicEvidence[]=topic.evidence.map((entry:unknown)=>{if(!entry || typeof entry!=='object' || Array.isArray(entry))throw new Error('Topic extraction returned invalid evidence.');const item=entry as Record<string,unknown>;const source=typeof item.sourceId==='string'?sourceMap.get(item.sourceId):undefined;if(!source || typeof item.quote!=='string' || !item.quote.trim() || !source.content.includes(item.quote))throw new Error('Topic extraction returned unsupported evidence.');return {messageId:source.id,role:source.role,sequence:source.sequence,quote:item.quote,existence:'verified' as const};});
    const unique=[...new Map(evidence.map(item=>[JSON.stringify([item.messageId,item.quote]),item])).values()].sort((a,b)=>a.sequence-b.sequence);
    return {key:topic.key.trim(),value:topic.value.trim(),status:topic.status as TopicCandidate['status'],sources:[...new Set(unique.map(item=>item.messageId))],evidence:unique,assessment:{support:'unverified' as const,change:'unverified' as const}};
  });
}
