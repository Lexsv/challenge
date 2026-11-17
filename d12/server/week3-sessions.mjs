import { randomUUID } from 'node:crypto';
import { createTopicRepository } from './topic-repository.mjs';
import { initializeWeek3ProfileReference } from './week3-profile-migration.mjs';

// Week 3 owns its session and event rows. Shared provider and tool data stay separate.
export function createWeek3Routes(db, validateEvent, options = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS week3_sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL DEFAULT 0, requestTokenLimit INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS week3_history_events (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES week3_sessions(id),
    sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    UNIQUE(sessionId, sequence)
  );
  CREATE TABLE IF NOT EXISTS week3_session_memory (
    sessionId TEXT PRIMARY KEY REFERENCES week3_sessions(id),
    revision INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL CHECK(json_valid(data))
  );`);
  initializeWeek3ProfileReference(db);
  const topicRepository=createTopicRepository(db);
  const get=db.prepare('SELECT id,title,createdAt,updatedAt,requestTokenLimit,profile_id AS profileId, 1 AS fullContext FROM week3_sessions WHERE id=?');
  const list=db.prepare('SELECT id,title,createdAt,updatedAt,requestTokenLimit,profile_id AS profileId, 1 AS fullContext FROM week3_sessions ORDER BY createdAt, rowid');
  const events=db.prepare('SELECT id,sessionId,sequence,type,payload FROM week3_history_events WHERE sessionId=? ORDER BY sequence');
  return async (req,path,reply) => {
    const match=path.match(/^\/api\/week3\/sessions(?:\/([a-zA-Z0-9-]+))?(?:\/(events|memory|topic-mode|segments))?$/);
    if (!match) return false;
    const [,id,resource]=match;
    if (!id && req.method==='GET') {reply(200,list.all());return true;}
    if (!id && req.method==='POST') {
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1048576){reply(413,{error:'Request too large.'});return true;}}
      let value;try{value=body.trim()?JSON.parse(body):{};}catch{reply(400,{error:'Invalid JSON.'});return true;}
      if(!value || typeof value!=='object' || Array.isArray(value) || (value.profileId!==undefined && (typeof value.profileId!=='string' || !value.profileId.trim() || value.profileId!==value.profileId.trim() || value.profileId.length>200))){reply(400,{error:'Invalid profile ID.'});return true;}
      const profileId=value.profileId ?? 'general', key=randomUUID();
      const inserted=db.prepare('INSERT INTO week3_sessions(id,title,createdAt,profile_id) SELECT ?,?,?,id FROM context_profiles WHERE id=?').run(key,'New session',Date.now(),profileId);
      if(!inserted.changes){reply(404,{error:'Profile not found.'});return true;}
      reply(201,get.get(key));return true;
    }
    if (!id || !get.get(id)) {reply(404,{error:'Session not found.'});return true;}
    if (!resource && req.method==='GET') {reply(200,get.get(id));return true;}
    if(resource==='topic-mode' && req.method==='GET'){reply(200,{enabled:typeof options.topicProcess==='function',...(options.mockModel?{mockModel:true,failSummary:!!options.mockSummaryFailure?.()}:{})});return true;}
    if(resource==='segments' && req.method==='POST'){
      if(typeof options.topicProcess!=='function'){reply(503,{error:'Topic processing is disabled.'});return true;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){reply(413,{error:'Request too large.'});return true;}}
      let value;try{value=JSON.parse(body);}catch{reply(400,{error:'Invalid JSON.'});return true;}
      if(!value || Object.keys(value).join()!=='runId' || typeof value.runId!=='string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.runId)){reply(400,{error:'Invalid segment request.'});return true;}
      let source;
      try{source=topicRepository.segment(id,[value.runId]);}catch{reply(404,{error:'Segment not found in this session.'});return true;}
      try {
        if(source.completed){reply(200,{status:'already_completed',segmentId:source.segmentId});return true;}
        await options.topicProcess(topicRepository,id,value.runId);
        const after=topicRepository.segment(id,[value.runId]);
        if(!after.completed)throw new Error('Segment processing did not complete.');
        reply(200,{status:'completed',segmentId:after.segmentId});
      }catch{reply(500,{error:'Topic processing failed. Please retry.'});}
      return true;
    }
    if (resource==='memory' && req.method==='GET') {
      const row=db.prepare('SELECT revision,data FROM week3_session_memory WHERE sessionId=?').get(id);
      reply(200,row ? {revision:row.revision,data:JSON.parse(row.data)} : {revision:0,data:null});return true;
    }
    if (resource==='memory' && req.method==='PUT') {
      let body='';for await (const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>1048576){reply(413,{error:'Request too large.'});return true;}}
      let value;try{value=JSON.parse(body);}catch{reply(400,{error:'Invalid JSON.'});return true;}
      if (!Number.isSafeInteger(value?.revision) || value.revision<0 || !value.data || typeof value.data!=='object' || Array.isArray(value.data)) {reply(400,{error:'Invalid memory.'});return true;}
      db.exec('BEGIN IMMEDIATE');try {
        const row=db.prepare('SELECT revision FROM week3_session_memory WHERE sessionId=?').get(id);
        if ((row?.revision ?? 0)!==value.revision) {db.exec('ROLLBACK');reply(409,{error:'Memory revision conflict.'});return true;}
        const revision=value.revision+1;
        db.prepare('INSERT INTO week3_session_memory(sessionId,revision,data) VALUES(?,?,?) ON CONFLICT(sessionId) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(id,revision,JSON.stringify(value.data));
        db.exec('COMMIT');reply(200,{revision,data:value.data});return true;
      } catch(error) {db.exec('ROLLBACK');throw error;}
    }
    if (resource==='events' && req.method==='GET') {
      const rows=events.all(id).map(row=>({...row,payload:JSON.parse(row.payload)}));
      const search=new URL(req.url,'http://localhost').searchParams;
      reply(200,search.has('limit') ? {events:rows,nextBefore:null,snapshot:rows.at(-1)?.sequence ?? 0,accountingEvents:rows} : rows);return true;
    }
    if ((resource==='events' && req.method==='POST') || (!resource && req.method==='PATCH')) {
      let body='';for await (const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>1048576){reply(413,{error:'Request too large.'});return true;}}
      let value;try{value=JSON.parse(body);}catch{reply(400,{error:'Invalid JSON.'});return true;}
      if (resource==='events') {
        const payload=validateEvent(value,id);if(!payload){reply(400,{error:'Invalid history event.'});return true;}
        const prior=db.prepare('SELECT * FROM week3_history_events WHERE id=?').get(value.id), serialized=JSON.stringify(payload);
        if(prior){if(prior.sessionId!==id || prior.type!==value.type || prior.payload!==serialized){reply(409,{error:'Event ID conflict.'});return true;}reply(200,{...prior,payload});return true;}
        const entity=(type,entityId)=>db.prepare("SELECT payload FROM week3_history_events WHERE sessionId=? AND type=? AND json_extract(payload,'$.id')=? ORDER BY sequence LIMIT 1").get(id,type,entityId);
        if (['metering','context','tool-call','tool-result'].includes(value.type) && !entity('run',payload.runId)) {reply(400,{error:'Unknown run.'});return true;}
        if (value.type==='tool-call' && entity('tool-call',payload.id)) {reply(409,{error:'Call already recorded.'});return true;}
        if (value.type==='tool-result') {
          const saved=entity('tool-call',payload.id), call=saved && JSON.parse(saved.payload);
          if (!call || call.runId!==payload.runId || call.toolCallId!==payload.toolCallId || call.toolId!==payload.toolId || JSON.stringify(call.arguments)!==JSON.stringify(payload.arguments)) {reply(400,{error:'Result does not match a saved call.'});return true;}
          if (entity('tool-result',payload.id)) {reply(409,{error:'Result already recorded.'});return true;}
        }
        db.exec('BEGIN IMMEDIATE');try {
          db.prepare('INSERT INTO week3_history_events(id,sessionId,sequence,type,payload) VALUES(?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM week3_history_events WHERE sessionId=?),?,?)').run(value.id,id,id,value.type,serialized);
          db.prepare('UPDATE week3_sessions SET updatedAt=? WHERE id=?').run(Date.now(),id);db.exec('COMMIT');
        } catch(error) {db.exec('ROLLBACK');throw error;}
        reply(201,{...db.prepare('SELECT * FROM week3_history_events WHERE id=?').get(value.id),payload});return true;
      }
      if (typeof value.title==='string' && value.title.trim() && value.title.length<=200 && Object.keys(value).length===1) db.prepare('UPDATE week3_sessions SET title=?,updatedAt=? WHERE id=?').run(value.title.trim(),Date.now(),id);
      else if (Number.isSafeInteger(value.requestTokenLimit) && value.requestTokenLimit>=0 && Object.keys(value).length===1) db.prepare('UPDATE week3_sessions SET requestTokenLimit=? WHERE id=?').run(value.requestTokenLimit,id);
      else {reply(400,{error:'Invalid session update.'});return true;}
      reply(200,get.get(id));return true;
    }
    if (!resource && req.method==='DELETE') {db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM week3_session_memory WHERE sessionId=?').run(id);db.prepare('DELETE FROM week3_history_events WHERE sessionId=?').run(id);db.prepare('DELETE FROM week3_sessions WHERE id=?').run(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}reply(200,{id,deleted:true});return true;}
    reply(405,{error:'Method not allowed.'});return true;
  };
}
