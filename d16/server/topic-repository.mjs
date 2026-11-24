import { createHash } from 'node:crypto';
import { mapTopicAssessment } from '../src/assessment-mapper.ts';
import { validateTopicAssessment } from '../src/topic-semantic.ts';

/** Isolated repository: initialize only an explicitly supplied database. */
export function createTopicRepository(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS week3_topics (
      session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE, topic_key TEXT NOT NULL COLLATE NOCASE,
      value TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','uncertain','rejected')),
      revision INTEGER NOT NULL, PRIMARY KEY(session_id,topic_key));
    CREATE TABLE IF NOT EXISTS week3_topic_changes (
      session_id TEXT NOT NULL, topic_key TEXT NOT NULL COLLATE NOCASE, ordinal INTEGER NOT NULL,
      mutation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('creation','update','correction','cancellation','confirmation')),
      previous_value TEXT, new_value TEXT NOT NULL, status TEXT NOT NULL,
      classification TEXT NOT NULL, fact_supported INTEGER NOT NULL, change_confirmed INTEGER NOT NULL,
      PRIMARY KEY(session_id,topic_key,ordinal), UNIQUE(session_id,topic_key,mutation_id),
      FOREIGN KEY(session_id,topic_key) REFERENCES week3_topics(session_id,topic_key) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS week3_topic_evidence (
      session_id TEXT NOT NULL, topic_key TEXT NOT NULL COLLATE NOCASE, ordinal INTEGER NOT NULL,
      message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      archive_sequence INTEGER NOT NULL, quote TEXT NOT NULL, assessed INTEGER NOT NULL CHECK(assessed IN (0,1)),
      PRIMARY KEY(session_id,topic_key,ordinal,message_id,quote),
      FOREIGN KEY(session_id,topic_key,ordinal) REFERENCES week3_topic_changes(session_id,topic_key,ordinal) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS week3_topic_segments (
      session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL, run_ids TEXT NOT NULL CHECK(json_valid(run_ids)),
      PRIMARY KEY(session_id,segment_id));`);
  const topic=db.prepare('SELECT topic_key AS key,value,status,revision FROM week3_topics WHERE session_id=? AND topic_key=?');
  const catalogFirst=db.prepare('SELECT topic_key AS key,value,status,revision FROM week3_topics WHERE session_id=? ORDER BY topic_key COLLATE NOCASE LIMIT ?');
  const catalogAfter=db.prepare('SELECT topic_key AS key,value,status,revision FROM week3_topics WHERE session_id=? AND topic_key COLLATE NOCASE > ? COLLATE NOCASE ORDER BY topic_key COLLATE NOCASE LIMIT ?');
  const catalogAll=db.prepare('SELECT topic_key AS key,value,status,revision FROM week3_topics WHERE session_id=? ORDER BY topic_key COLLATE NOCASE');
  const changes=db.prepare('SELECT ordinal,mutation_id AS mutationId,kind,previous_value AS previousValue,new_value AS newValue,status,classification,fact_supported AS factSupported,change_confirmed AS changeConfirmed FROM week3_topic_changes WHERE session_id=? AND topic_key=? ORDER BY ordinal');
  const evidence=db.prepare('SELECT message_id AS messageId,role,archive_sequence AS sequence,quote,assessed FROM week3_topic_evidence WHERE session_id=? AND topic_key=? AND ordinal=? ORDER BY archive_sequence,message_id,quote');
  const archived=db.prepare("SELECT sequence,payload FROM week3_history_events WHERE sessionId=? AND type='message' AND json_extract(payload,'$.id')=?");
  const read=(sessionId,key)=>{const row=topic.get(sessionId,key);if(!row)return null;return {...row,history:changes.all(sessionId,key).map(change=>({...change,factSupported:!!change.factSupported,changeConfirmed:!!change.changeConfirmed,evidence:evidence.all(sessionId,key,change.ordinal)})),historyOrder:'processing_order_not_verified_chronology'};};
  const write=(sessionId, update, assessment, expectedRevision)=>{
      if(!sessionId || !update?.candidate?.key?.trim() || !Number.isSafeInteger(expectedRevision) || expectedRevision<0)throw new Error('Invalid topic write.');
      const {candidate,action}=update;
      if(!['new','confirm','change'].includes(action) || candidate.assessment?.support!=='supported' || !assessment?.factSupported || !Array.isArray(candidate.evidence) || !candidate.evidence.length)throw new Error('Topic write requires an accepted decision.');
      if(action==='change' && (candidate.assessment.change!=='confirmed' || !assessment.changeConfirmed || !['change','cancellation'].includes(assessment.classification)))throw new Error('Topic change is not confirmed.');
      const key=action==='new'?candidate.key.trim():update.targetKey?.trim();if(!key || candidate.key.trim().toLocaleLowerCase()!==key.toLocaleLowerCase())throw new Error('Invalid topic identity.');
      const normalizedEvidence=[...new Map(candidate.evidence.map(e=>[JSON.stringify([e.messageId,e.quote]),e])).values()].sort((a,b)=>a.messageId.localeCompare(b.messageId)||a.quote.localeCompare(b.quote));
      const fingerprint=createHash('sha256').update(JSON.stringify([action,key.toLocaleLowerCase(),candidate.value,candidate.status,assessment.classification,normalizedEvidence.map(e=>[e.messageId,e.quote])])).digest('hex');
        for(const item of normalizedEvidence){const rows=archived.all(sessionId,item.messageId);if(rows.length!==1)throw new Error('Evidence message is unavailable in this session.');const original=JSON.parse(rows[0].payload);if(rows[0].sequence!==item.sequence || original.role!==item.role || typeof item.quote!=='string' || !item.quote.trim() || !original.text.includes(item.quote) || item.existence!=='verified')throw new Error('Evidence does not match the archive.');}
        const existing=topic.get(sessionId,key);
        if(existing && db.prepare('SELECT 1 FROM week3_topic_changes WHERE session_id=? AND topic_key=? AND mutation_id=?').get(sessionId,key,fingerprint))return read(sessionId,key);
        if((existing?.revision ?? 0)!==expectedRevision)throw new Error('Topic revision conflict.');
        if((action==='new')===!!existing)throw new Error('Topic already exists or is missing.');
        if(action==='confirm' && (candidate.value!==existing.value || candidate.status!==existing.status))throw new Error('Confirmation must match the current value.');
        if(action==='change' && candidate.status!=='confirmed')throw new Error('Topic change is not confirmed.');
        if(!existing)db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run(sessionId,key,candidate.value,candidate.status,1);
        else db.prepare('UPDATE week3_topics SET value=?,status=?,revision=revision+1 WHERE session_id=? AND topic_key=?').run(candidate.value,candidate.status,sessionId,key);
        const ordinal=existing ? existing.revision+1 : 1;
        const kind=action==='new'?'creation':action==='confirm'?'confirmation':assessment.classification==='cancellation'?'cancellation':'update';
        db.prepare('INSERT INTO week3_topic_changes VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(sessionId,key,ordinal,fingerprint,kind,existing?.value ?? null,candidate.value,candidate.status,assessment.classification,Number(assessment.factSupported),Number(assessment.changeConfirmed));
        const insert=db.prepare('INSERT INTO week3_topic_evidence VALUES (?,?,?,?,?,?,?,?)');for(const item of normalizedEvidence)insert.run(sessionId,key,ordinal,item.messageId,item.role,item.sequence,item.quote,Number(assessment.evidence.some(e=>e.messageId===item.messageId && e.quote===item.quote)));
        return read(sessionId,key);
  };
  const segment=(sessionId,runIds)=>{
    if(!sessionId || !Array.isArray(runIds) || !runIds.length || runIds.some(id=>typeof id!=='string' || !id.trim()) || new Set(runIds).size!==runIds.length)throw new Error('Invalid segment identity.');
    const ids=[...runIds].sort();
    const events=[];const query=db.prepare("SELECT id,sessionId,sequence,type,payload FROM week3_history_events WHERE sessionId=? AND type='message' AND json_extract(payload,'$.runId')=? ORDER BY sequence");
    for(const id of ids){const rows=query.all(sessionId,id);if(!rows.length)throw new Error('Segment run is unavailable in this session.');events.push(...rows.map(row=>({...row,payload:JSON.parse(row.payload)})));}
    events.sort((a,b)=>a.sequence-b.sequence);
    const segmentId=createHash('sha256').update(JSON.stringify([sessionId,ids,events.map(event=>[event.id,event.sequence,event.payload.id])])).digest('hex');
    return {segmentId,runIds:ids,events,completed:!!db.prepare('SELECT 1 FROM week3_topic_segments WHERE session_id=? AND segment_id=?').get(sessionId,segmentId)};
  };
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const controlledSnapshot=(sessionId,runId)=>{
    db.exec('BEGIN');
    try {
      const source=segment(sessionId,[runId]);const topics=catalogAll.all(sessionId);
      const result={segmentId:source.segmentId,sourceRevision:digest(source.events),catalogRevision:digest(topics),completed:source.completed,events:source.events,topics};
      db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  };
  return {
    get:read,
    catalog(sessionId,options={}){
      if(typeof sessionId!=='string' || !sessionId.trim() || !options || typeof options!=='object' || Array.isArray(options))throw new Error('Invalid topic catalog request.');
      const {limit=50,after}=options;
      if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (after!==undefined && (typeof after!=='string' || !after.trim())))throw new Error('Invalid topic catalog pagination.');
      const rows=after===undefined?catalogFirst.all(sessionId,limit+1):catalogAfter.all(sessionId,after,limit+1);
      const topics=rows.slice(0,limit);
      return {topics,nextCursor:rows.length>limit?topics[topics.length-1].key:null};
    },
    segment,
    controlledSnapshot,
    // Isolated contract: callers must explicitly authorize a complete, trusted analysis.
    commitControlledSegment(sessionId,runId,request){
      if(!request || request.authorized!==true || request.analysisComplete!==true || !Array.isArray(request.proposals) || !Number.isSafeInteger(request.candidateCount) || request.candidateCount<0 || request.candidateCount!==request.proposals.length || !['segmentId','sourceRevision','catalogRevision'].every(key=>typeof request[key]==='string' && /^[a-f0-9]{64}$/.test(request[key])))throw new Error('Invalid or unauthorized controlled analysis.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const source=segment(sessionId,[runId]);
        if(source.segmentId!==request.segmentId || digest(source.events)!==request.sourceRevision)throw new Error('Archived segment changed during processing.');
        if(source.completed){db.exec('COMMIT');return {completed:true,alreadyCompleted:true};}
        const entries=catalogAll.all(sessionId);
        if(digest(entries)!==request.catalogRevision)throw new Error('Topic catalog revision conflict.');
        const current=entries.map(entry=>({...entry,sources:[],archiveSequence:null,history:[]}));
        const mutations=[];const mutationKeys=new Set();
        for(const proposal of request.proposals){
          if(!proposal || !Object.hasOwn(proposal,'candidate') || !Object.hasOwn(proposal,'recommendation') || !Object.hasOwn(proposal,'expectedTopicRevision'))throw new Error('Every candidate requires a complete proposal.');
          const {candidate,recommendation,assessment,expectedTopicRevision}=proposal;
          if(!Number.isSafeInteger(expectedTopicRevision) || expectedTopicRevision<0)throw new Error('Invalid expected topic revision.');
          const mapped=mapTopicAssessment({sessionId,events:source.events,candidate,recommendation,assessment,existingTopics:current});
          if(mapped.decision==='reject' || mapped.decision==='defer')throw new Error('Candidate rejected or deferred.');
          if(mapped.decision==='no-mutation'){
            const target=recommendation.action==='DUPLICATE'?current.find(entry=>entry.key===recommendation.targetKey):undefined;
            if((target?.revision ?? 0)!==expectedTopicRevision)throw new Error('Topic revision conflict.');
            continue;
          }
          const target=mapped.targetKey?current.find(entry=>entry.key===mapped.targetKey):undefined;
          if((target?.revision ?? 0)!==expectedTopicRevision)throw new Error('Topic revision conflict.');
          const result=validateTopicAssessment(sessionId,source.events,mapped.candidate,mapped.assessment,target);
          if(result.decision!=='accept')throw new Error('Candidate rejected or deferred.');
          const identity=(result.update.targetKey ?? result.update.candidate.key).replace(/[A-Z]/g,char=>char.toLowerCase());
          if(mutationKeys.has(identity))throw new Error('Conflicting topic proposals.');
          mutationKeys.add(identity);mutations.push({update:result.update,assessment:mapped.assessment,expectedTopicRevision});
        }
        for(const item of mutations)write(sessionId,item.update,item.assessment,item.expectedTopicRevision);
        db.prepare('INSERT INTO week3_topic_segments(session_id,segment_id,run_ids) VALUES (?,?,?)').run(sessionId,source.segmentId,JSON.stringify(source.runIds));
        db.exec('COMMIT');return {completed:true,alreadyCompleted:false};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    commit(sessionId,update,assessment,expectedRevision){db.exec('BEGIN IMMEDIATE');try{const result=write(sessionId,update,assessment,expectedRevision);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    commitSegment(sessionId,runIds,outcomes,expectedSegmentId){
      db.exec('BEGIN IMMEDIATE');
      try {
        const source=segment(sessionId,runIds);if(source.segmentId!==expectedSegmentId)throw new Error('Archived segment changed during processing.');if(source.completed){db.exec('COMMIT');return {completed:true,alreadyCompleted:true};}
        if(!Array.isArray(outcomes))throw new Error('Every candidate requires a policy outcome.');
        const messageIds=new Set(source.events.map(event=>event.payload.id));
        for(const outcome of outcomes){
          if(!outcome || !['accept','reject','defer'].includes(outcome.decision))throw new Error('Invalid candidate policy outcome.');
          if(outcome.decision==='accept'){
            if(!outcome.update?.candidate?.evidence?.every(item=>messageIds.has(item.messageId)))throw new Error('Evidence is outside the archived segment.');
            write(sessionId,outcome.update,outcome.assessment,outcome.expectedRevision);
          }
        }
        db.prepare('INSERT INTO week3_topic_segments(session_id,segment_id,run_ids) VALUES (?,?,?)').run(sessionId,source.segmentId,JSON.stringify(source.runIds));
        db.exec('COMMIT');return {completed:true,alreadyCompleted:false};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
  };
}
