import { createHistoryPager } from './history-pages.mjs';
import { createWeek3Routes } from './week3-sessions.mjs';
import { createContextProfileRepository } from './context-profile-repository.mjs';
import { createContextProfileRoutes } from './context-profile-routes.mjs';
import { createContextWorkspaceStore } from './context-workspaces.mjs';
import { createCredentialRoutes } from "./credentials.mjs";
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function validateEvent(event, sessionId) {
  if (!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(event.id) || event.sessionId !== sessionId) return null;
  const p = event.payload;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.runId !== 'string' && event.type !== 'run') return null;
  if (event.type === 'context') return validateContext(p);
  if (event.type === 'metering') return validateMeter(p, sessionId);
  const fields = {
    message: ['id', 'conversationId', 'runId', 'createdAt', 'role', 'type', 'text'],
    run: ['id', 'conversationId', 'agentId', 'status', 'startedAt', 'endedAt', 'messageIds', 'toolExecutionIds'],
    'tool-call': ['id', 'runId', 'toolCallId', 'toolId', 'status', 'arguments', 'startedAt'],
    'tool-result': ['id', 'runId', 'toolCallId', 'toolId', 'status', 'arguments', 'output', 'error', 'startedAt', 'endedAt'],
  }[event.type];
  if (!fields || Object.keys(p).some((key) => !fields.includes(key))) return null;
  if (event.type === 'message' && (p.conversationId !== sessionId || p.type !== 'text' || !['user', 'assistant', 'system'].includes(p.role) || typeof p.text !== 'string' || !Number.isFinite(p.createdAt))) return null;
  if (event.type === 'run' && (p.conversationId !== sessionId || typeof p.agentId !== 'string' || !Array.isArray(p.messageIds) || !Array.isArray(p.toolExecutionIds))) return null;
  if (event.type !== 'message' && (!Number.isFinite(p.startedAt) || !['pending', 'running', 'completed', 'failed', 'incomplete'].includes(p.status))) return null;
  if (event.type.startsWith('tool-') && (typeof p.toolId !== 'string' || typeof p.toolCallId !== 'string' || !Object.hasOwn(p, 'arguments'))) return null;
  if (event.type === 'tool-result' && (!Number.isFinite(p.endedAt) || !['completed', 'failed'].includes(p.status))) return null;
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(p, key)).map((key) => [key, p[key]]));
}

function validateContext(p) {
  const fields = ['id', 'runId', 'createdAt', 'phase', 'summary', 'coveredEventId', 'coveredRunIds', 'beforeTokens', 'afterTokens', 'failureStage', 'reason', 'constraint', 'budget'];
  if (Object.keys(p).some((key) => !fields.includes(key)) || !Number.isFinite(p.createdAt) || !['overflow', 'compacting', 'completed', 'retrying', 'failed', 'target-missed'].includes(p.phase)) return null;
  for (const key of ['beforeTokens', 'afterTokens']) if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || p[key] < 0)) return null;
  if (p.failureStage !== undefined && !['summary', 'answer-budget'].includes(p.failureStage)) return null;
  if (p.reason !== undefined && !['summary-unavailable', 'estimate-unavailable', 'not-reduced', 'over-limit'].includes(p.reason)) return null;
  if (p.constraint !== undefined && !['session', 'model'].includes(p.constraint)) return null;
  if (p.budget !== undefined) {
    if (!p.budget || typeof p.budget !== 'object' || Object.keys(p.budget).some(k => !['limit', 'modelInputBudget', 'requestTokenLimit', 'requiredTokens', 'currentInputTokens', 'retainedTurnsTokens', 'instructionsTokens', 'toolDefinitionTokens', 'requestOverheadTokens'].includes(k))) return null;
    if (Object.values(p.budget).some(v => !Number.isSafeInteger(v) || v < 0)) return null;
  }
  if (p.phase === 'completed') {
    if (typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 200000 || typeof p.coveredEventId !== 'string' || !Array.isArray(p.coveredRunIds) || !p.coveredRunIds.length || p.coveredRunIds.some((v) => typeof v !== 'string')) return null;
  } else if (['summary', 'coveredEventId', 'coveredRunIds'].some((key) => p[key] !== undefined)) return null;
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(p, key)).map((key) => [key, p[key]]));
}

function validateMeter(p, sessionId) {
  const fields = ['id', 'sessionId', 'runId', 'toolExecutionOffset', 'provider', 'model', 'actualModel', 'requestKind', 'sentInputTokens', 'beforeInputTokens', 'afterInputTokens', 'compacted', 'library', 'startedAt', 'endedAt', 'status', 'encoding', 'estimatedInputTokens', 'actualInputTokens', 'actualOutputTokens', 'actualTotalTokens', 'cachedInputTokens', 'pricing', 'actualPricing', 'estimatedInputCost', 'estimatedRequestCost'];
  if (Object.keys(p).some((key) => !fields.includes(key)) || p.sessionId !== sessionId || p.library !== 'js-tiktoken' || !['openai', 'opencode-console', 'opencode-go'].includes(p.provider) || typeof p.model !== 'string' || p.model.length > 200 || !['running', 'completed', 'failed', 'incomplete'].includes(p.status)) return null;
  if (typeof p.runId !== 'string' || !Number.isFinite(p.startedAt) || (p.endedAt !== undefined && !Number.isFinite(p.endedAt))) return null;
  if (p.requestKind !== undefined && !['answer', 'summary', 'extraction'].includes(p.requestKind)) return null;
  if (p.compacted !== undefined && typeof p.compacted !== 'boolean') return null;
  if (p.actualModel !== undefined && (typeof p.actualModel !== 'string' || p.actualModel.length > 200)) return null;
  if (p.encoding !== undefined && !['o200k_base', 'cl100k_base'].includes(p.encoding)) return null;
  for (const key of ['sentInputTokens', 'beforeInputTokens', 'afterInputTokens', 'toolExecutionOffset', 'estimatedInputTokens', 'actualInputTokens', 'actualOutputTokens', 'actualTotalTokens', 'cachedInputTokens']) if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || p[key] < 0)) return null;
  for (const key of ['estimatedInputCost', 'estimatedRequestCost']) if (p[key] !== undefined && (!Number.isFinite(p[key]) || p[key] < 0)) return null;
  for (const name of ['pricing', 'actualPricing']) if (p[name] !== undefined) {
    const price = p[name];
    if (!price || typeof price !== 'object' || Object.keys(price).some((key) => !['currency', 'inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion', 'source', 'asOf'].includes(key)) || price.currency !== 'USD' || !['openai-model-page', 'opencode-catalog'].includes(price.source) || typeof price.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(price.asOf)) return null;
    if (['inputPerMillion', 'outputPerMillion'].some((key) => !Number.isFinite(price[key]) || price[key] < 0) || (price.cachedInputPerMillion !== undefined && (!Number.isFinite(price.cachedInputPerMillion) || price.cachedInputPerMillion < 0))) return null;
  }
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(p, key)).map((key) => [key, p[key]]));
}

export function createSessionServer(databasePath = fileURLToPath(new URL('../data/sessions.sqlite', import.meta.url)), options = {}) {
  if(options.mockModel && process.env.NODE_ENV==='production')throw new Error('The test model is unavailable in production.');
  const credentialRoutes = createCredentialRoutes(options.credentialStore, options.fetcher);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const profileRoutes = createContextProfileRoutes(createContextProfileRepository(db));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
      createdAt INTEGER NOT NULL
    );
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS history_events (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('message', 'run', 'tool-call', 'tool-result', 'metering', 'context')),
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      UNIQUE(sessionId, sequence)
    );
    CREATE TABLE IF NOT EXISTS session_facts (
      sessionId TEXT PRIMARY KEY REFERENCES sessions(id),
      facts TEXT NOT NULL CHECK(json_valid(facts)),
      coveredMessageId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_functions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, pseudocode TEXT NOT NULL
    );`);
  // SQLite cannot alter a CHECK constraint. Rebuild only the event table, atomically preserving every row.
  const historySchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history_events'").get().sql;
  if (!historySchema.includes("'context'")) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE history_events_extended (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('message', 'run', 'tool-call', 'tool-result', 'metering', 'context')),
        payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sessionId, sequence)
      );
      INSERT INTO history_events_extended SELECT id, sessionId, sequence, type, payload FROM history_events;
      DROP TABLE history_events;
      ALTER TABLE history_events_extended RENAME TO history_events;`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'requestTokenLimit')) {
    db.exec('ALTER TABLE sessions ADD COLUMN requestTokenLimit INTEGER NOT NULL DEFAULT 0 CHECK(requestTokenLimit >= 0)');
  }
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name);
  if (!sessionColumns.includes('contextStrategy')) db.exec("ALTER TABLE sessions ADD COLUMN contextStrategy TEXT NOT NULL DEFAULT 'token-budget' CHECK(contextStrategy IN ('token-budget','key-facts'))");
  if (!sessionColumns.includes('recentMessages')) db.exec('ALTER TABLE sessions ADD COLUMN recentMessages INTEGER NOT NULL DEFAULT 10 CHECK(recentMessages > 0)');
  if (!sessionColumns.includes('fullContext')) db.exec('ALTER TABLE sessions ADD COLUMN fullContext INTEGER NOT NULL DEFAULT 0 CHECK(fullContext IN (0,1))');
  if (!sessionColumns.includes('slidingSelected')) db.exec('ALTER TABLE sessions ADD COLUMN slidingSelected INTEGER NOT NULL DEFAULT 0 CHECK(slidingSelected IN (0,1))');
  if (!sessionColumns.includes('stickySelected')) {
    db.exec("ALTER TABLE sessions ADD COLUMN stickySelected INTEGER NOT NULL DEFAULT 0 CHECK(stickySelected IN (0,1)); UPDATE sessions SET stickySelected=1 WHERE contextStrategy='key-facts' AND fullContext=0 AND slidingSelected=0");
  }
  if (!sessionColumns.includes('memorySelected')) db.exec('ALTER TABLE sessions ADD COLUMN memorySelected INTEGER NOT NULL DEFAULT 0 CHECK(memorySelected IN (0,1))');
  db.exec(`CREATE TABLE IF NOT EXISTS sliding_sessions (
    parentId TEXT PRIMARY KEY REFERENCES sessions(id), childId TEXT UNIQUE NOT NULL REFERENCES sessions(id)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS sticky_sessions (parentId TEXT PRIMARY KEY REFERENCES sessions(id), childId TEXT UNIQUE NOT NULL REFERENCES sessions(id))');
  db.exec('CREATE TABLE IF NOT EXISTS memory_sessions (parentId TEXT PRIMARY KEY REFERENCES sessions(id), childId TEXT UNIQUE NOT NULL REFERENCES sessions(id))');
  db.exec("CREATE TABLE IF NOT EXISTS session_memory (sessionId TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER NOT NULL DEFAULT 0, entries TEXT NOT NULL CHECK(json_valid(entries)))");
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'updatedAt')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET updatedAt = MAX(createdAt, COALESCE((SELECT MAX(COALESCE(json_extract(payload,'$.endedAt'), json_extract(payload,'$.createdAt'), json_extract(payload,'$.startedAt'),0)) FROM history_events WHERE sessionId = sessions.id),0));`);
  }
  const touch = db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?');
  const saveLimit = db.prepare('UPDATE sessions SET requestTokenLimit = ? WHERE id = ?');
  const saveStrategy = db.prepare('UPDATE sessions SET contextStrategy = ? WHERE id = ?');
  const saveRecent = db.prepare('UPDATE sessions SET recentMessages = ? WHERE id = ?');
  const saveFullContext = db.prepare('UPDATE sessions SET fullContext = ? WHERE id = ?');
  const list = db.prepare('SELECT id, title, createdAt, requestTokenLimit, contextStrategy, recentMessages, fullContext, slidingSelected, stickySelected, memorySelected, updatedAt FROM sessions WHERE id NOT IN (SELECT childId FROM sliding_sessions UNION SELECT childId FROM sticky_sessions UNION SELECT childId FROM memory_sessions) ORDER BY createdAt, rowid');
  const get = db.prepare('SELECT id, title, createdAt, requestTokenLimit, contextStrategy, recentMessages, fullContext, slidingSelected, stickySelected, memorySelected FROM sessions WHERE id = ?');
  const insert = db.prepare('INSERT INTO sessions (id, title, createdAt, requestTokenLimit) VALUES (?, ?, ?, 0)');
  const deleteHistory = db.prepare('DELETE FROM history_events WHERE sessionId = ?');
  const deleteFacts = db.prepare('DELETE FROM session_facts WHERE sessionId = ?');
  const getFacts = db.prepare('SELECT facts, coveredMessageId FROM session_facts WHERE sessionId = ?');
  const putFacts = db.prepare('INSERT INTO session_facts (sessionId, facts, coveredMessageId) VALUES (?, ?, ?) ON CONFLICT(sessionId) DO UPDATE SET facts=excluded.facts, coveredMessageId=excluded.coveredMessageId');
  const deleteMetadata = db.prepare('DELETE FROM sessions WHERE id = ?');
  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
  const history = db.prepare('SELECT id, sessionId, sequence, type, payload FROM history_events WHERE sessionId = ? ORDER BY sequence');
  const pager = createHistoryPager(db);
  const week3Routes = createWeek3Routes(db, validateEvent, {topicProcess:options.topicProcess,mockModel:options.mockModel,mockSummaryFailure:options.mockSummaryFailure});
  const workspaces = createContextWorkspaceStore(db);
  const existingEvent = db.prepare('SELECT * FROM history_events WHERE id = ?');
  const findEntity = db.prepare("SELECT payload FROM history_events WHERE sessionId = ? AND type = ? AND json_extract(payload, '$.id') = ? ORDER BY sequence LIMIT 1");
  const addEvent = db.prepare('INSERT INTO history_events (id, sessionId, sequence, type, payload) VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM history_events WHERE sessionId = ?), ?, ?)');
  const slidingChild = db.prepare('SELECT childId FROM sliding_sessions WHERE parentId = ?');
  const slidingParent = db.prepare('SELECT parentId FROM sliding_sessions WHERE childId = ?');
  const insertSliding = db.prepare('INSERT INTO sliding_sessions (parentId, childId) VALUES (?, ?)');
  const selectSliding = db.prepare('UPDATE sessions SET slidingSelected = ?, stickySelected = CASE WHEN ?=1 THEN 0 ELSE stickySelected END, memorySelected=0 WHERE id = ?');
  const stickyChild = db.prepare('SELECT childId FROM sticky_sessions WHERE parentId = ?');
  const stickyParent = db.prepare('SELECT parentId FROM sticky_sessions WHERE childId = ?');
  const selectSticky = db.prepare('UPDATE sessions SET stickySelected = ?, slidingSelected = CASE WHEN ?=1 THEN 0 ELSE slidingSelected END, memorySelected=0 WHERE id = ?');
  const memoryChild=db.prepare('SELECT childId FROM memory_sessions WHERE parentId=?');
  const functions = db.prepare('SELECT id, name, description, pseudocode FROM custom_functions ORDER BY rowid');
  const findFunction = db.prepare('SELECT id, name, description, pseudocode FROM custom_functions WHERE id = ?');
  const insertFunction = db.prepare('INSERT INTO custom_functions (id, name, description, pseudocode) VALUES (?, ?, ?, ?)');
  const updateFunction = db.prepare('UPDATE custom_functions SET name = ?, description = ?, pseudocode = ? WHERE id = ?');
  const deleteFunction = db.prepare('DELETE FROM custom_functions WHERE id = ?');
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
      reply(403, { error: "Host not allowed." }); return;
    }
    // Mutations must originate from the same local UI host. No cross-origin access is enabled.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      reply(403, { error: 'Origin not allowed.' }); return;
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
    try {
      if (await profileRoutes(req, path, reply)) return;
      if (await week3Routes(req, path, reply)) return;
      if (await credentialRoutes(req, path, reply)) return;
      const workspaceRoute = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/(checkpoints|branches)$/);
      if (workspaceRoute) {
        const [, id, action] = workspaceRoute;
        if (!get.get(id) || slidingParent.get(id) || stickyParent.get(id) || db.prepare('SELECT 1 FROM memory_sessions WHERE childId=?').get(id)) { reply(404,{error:'Session not found.'}); return; }
        if (action === 'checkpoints' && req.method === 'GET') { reply(200,workspaces.checkpoints(id,'full')); return; }
        if (req.method !== 'POST') { reply(405,{error:'Method not allowed.'}); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { reply(415,{error:'JSON required.'}); return; }
        let body=''; for await (const chunk of req) { body+=chunk; if (Buffer.byteLength(body)>10000) { reply(413,{error:'Request too large.'}); return; } }
        let value; try { value=JSON.parse(body); } catch { reply(400,{error:'Invalid JSON.'}); return; }
        if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || (action === 'branches' && (typeof value.checkpointId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.checkpointId)))) { reply(400,{error:'Invalid checkpoint or branch.'}); return; }
        db.exec('BEGIN IMMEDIATE');
        try {
          if (action === 'checkpoints') {
            const capture = sourceId => ({ metadata:get.get(sourceId), events:history.all(sourceId), facts:getFacts.get(sourceId) ?? null, memory:db.prepare('SELECT revision, entries FROM session_memory WHERE sessionId=?').get(sourceId) ?? null });
            const children = Object.fromEntries([['sliding',slidingChild],['sticky',stickyChild],['memory',memoryChild]].map(([key,query])=>[key,query.get(id)?.childId]).filter(([,child])=>child).map(([key,child])=>[key,capture(child)]));
            const snapshot={root:capture(id),children};
            for (const part of [snapshot.root,...Object.values(children)]) {
              const latest = new Map();
              for (const row of part.events) if (row.type === 'run') { const run=JSON.parse(row.payload); latest.set(run.id,run.status); }
              if ([...latest.values()].some(status=>status==='running' || status==='pending')) { db.exec('ROLLBACK'); reply(409,{error:'Wait for the current run to finish before saving a checkpoint.'}); return; }
            }
            const branch=workspaces.create(id,'full','Checkpoint source',snapshot);
            const checkpoint=workspaces.checkpoint(id,'full',branch.id,value.name);
            db.exec('COMMIT'); reply(201,{id:checkpoint.id,name:checkpoint.name}); return;
          }
          const checkpoint=workspaces.checkpoints(id,'full').find(item=>item.id===value.checkpointId);
          if (!checkpoint) { db.exec('ROLLBACK'); reply(404,{error:'Checkpoint not found.'}); return; }
          const branch=workspaces.branchFrom(id,'full',value.checkpointId,value.name);
          const snapshot=branch.state, newRoot=randomUUID(), ids=new Map([[snapshot.root.metadata.id,newRoot]]);
          for (const part of Object.values(snapshot.children)) ids.set(part.metadata.id,randomUUID());
          const copy = (part,title) => {
            const meta=part.metadata, target=ids.get(meta.id);
            insert.run(target,title,Date.now());
            db.prepare('UPDATE sessions SET requestTokenLimit=?,contextStrategy=?,recentMessages=?,fullContext=?,slidingSelected=?,stickySelected=?,memorySelected=? WHERE id=?').run(meta.requestTokenLimit,meta.contextStrategy,meta.recentMessages,meta.fullContext,meta.slidingSelected,meta.stickySelected,meta.memorySelected,target);
            const eventIds = new Map(part.events.map(event=>[event.id,randomUUID()]));
            for (const event of part.events) {
              const payload=JSON.parse(event.payload);
              if (payload.conversationId === meta.id) payload.conversationId=target;
              if (payload.sessionId === meta.id) payload.sessionId=target;
              if (payload.coveredEventId && eventIds.has(payload.coveredEventId)) payload.coveredEventId=eventIds.get(payload.coveredEventId);
              addEvent.run(eventIds.get(event.id),target,target,event.type,JSON.stringify(payload));
            }
            if (part.facts) putFacts.run(target,part.facts.facts,part.facts.coveredMessageId);
            if (part.memory) db.prepare('INSERT INTO session_memory(sessionId,revision,entries) VALUES (?,?,?)').run(target,part.memory.revision,part.memory.entries);
            return target;
          };
          copy(snapshot.root,value.name.trim());
          for (const [key,part] of Object.entries(snapshot.children)) {
            const child=copy(part,part.metadata.title);
            const table={sliding:'sliding_sessions',sticky:'sticky_sessions',memory:'memory_sessions'}[key];
            db.prepare(`INSERT INTO ${table}(parentId,childId) VALUES (?,?)`).run(newRoot,child);
          }
          db.exec('COMMIT'); reply(201,get.get(newRoot)); return;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const memorySessionRoute=path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/memory-session$/);
      if (memorySessionRoute && req.method === 'POST') {
        const id=memorySessionRoute[1]; if(!get.get(id) || slidingParent.get(id) || stickyParent.get(id) || db.prepare('SELECT parentId FROM memory_sessions WHERE childId=?').get(id)){reply(404,{error:'Session not found.'});return;}
        db.exec('BEGIN IMMEDIATE'); try {let child=memoryChild.get(id);if(!child){const childId=randomUUID();insert.run(childId,'Key-Value Memory',Date.now());db.prepare('INSERT INTO memory_sessions(parentId,childId) VALUES(?,?)').run(id,childId);child={childId};}db.exec('COMMIT');reply(200,get.get(child.childId));return;}catch(error){db.exec('ROLLBACK');throw error;}
      }
      const memoryRoute=path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/memory$/);
      if (memoryRoute) {
        const id=memoryRoute[1];
        if (!get.get(id)) {reply(404,{error:'Session not found.'});return;}
        const read=()=>{const row=db.prepare('SELECT revision, entries FROM session_memory WHERE sessionId=?').get(id);return row ? {revision:row.revision,entries:JSON.parse(row.entries)} : {revision:0,entries:[]};};
        if (req.method === 'GET') {reply(200,read());return;}
        if (req.method === 'PUT') {
          if (!req.headers['content-type']?.startsWith('application/json')) {reply(415,{error:'JSON required.'});return;}
          let body=''; for await (const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>1048576){reply(413,{error:'Memory too large.'});return;}}
          let value; try {value=JSON.parse(body);} catch {reply(400,{error:'Invalid JSON.'});return;}
          if (!value || Object.keys(value).sort().join() !== 'entries,revision' || !Number.isSafeInteger(value.revision) || value.revision<0 || !Array.isArray(value.entries) || value.entries.some(e=>!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join() !== 'id,key,value' || typeof e.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(e.id) || typeof e.key !== 'string' || !e.key.trim() || e.key.length>300 || typeof e.value !== 'string' || !e.value.trim() || e.value.length>100000) || new Set(value.entries.map(e=>e.id)).size !== value.entries.length) {reply(400,{error:'Invalid memory.'});return;}
          db.exec('BEGIN IMMEDIATE');
          try {
            if (read().revision !== value.revision) {db.exec('ROLLBACK');reply(409,{error:'Memory changed.'});return;}
            db.prepare('INSERT INTO session_memory(sessionId,revision,entries) VALUES(?,?,?) ON CONFLICT(sessionId) DO UPDATE SET revision=excluded.revision,entries=excluded.entries').run(id,value.revision+1,JSON.stringify(value.entries));
            db.exec('COMMIT'); reply(200,read());return;
          } catch (error) {db.exec('ROLLBACK');throw error;}
        }
        reply(405,{error:'Method not allowed.'});return;
      }
      const stickyRoute = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/sticky$/);
      if (stickyRoute && req.method === 'POST') {
        const parentId=stickyRoute[1], parent=get.get(parentId);
        if (!parent || slidingParent.get(parentId) || stickyParent.get(parentId)) { reply(404,{error:'Session not found.'}); return; }
        db.exec('BEGIN IMMEDIATE');
        try {
          let child=stickyChild.get(parentId);
          if (!child) {
            const id=randomUUID(); insert.run(id,'Sticky Facts',Date.now());
            db.prepare("UPDATE sessions SET contextStrategy='key-facts', recentMessages=? WHERE id=?").run(parent.recentMessages,id);
            db.prepare('INSERT INTO sticky_sessions (parentId, childId) VALUES (?,?)').run(parentId,id);
            if (parent.contextStrategy === 'key-facts' || !parent.fullContext) {
              for (const row of history.all(parentId)) {
                const payload=JSON.parse(row.payload);
                if (payload.conversationId === parentId) payload.conversationId=id;
                if (payload.sessionId === parentId) payload.sessionId=id;
                addEvent.run(randomUUID(),id,id,row.type,JSON.stringify(payload));
              }
              const facts=getFacts.get(parentId); if (facts) putFacts.run(id,facts.facts,facts.coveredMessageId);
            }
            child={childId:id};
          }
          db.exec('COMMIT'); reply(200,get.get(child.childId)); return;
        } catch (error) {db.exec('ROLLBACK'); throw error;}
      }
      const slidingRoute = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/sliding$/);
      if (slidingRoute && req.method === 'POST') {
        const parentId = slidingRoute[1];
        if (!get.get(parentId) || slidingParent.get(parentId)) { reply(404, {error:'Session not found.'}); return; }
        db.exec('BEGIN IMMEDIATE');
        try {
          let child = slidingChild.get(parentId);
          if (!child) { const id = randomUUID(); insert.run(id, 'Sliding Window', Date.now()); insertSliding.run(parentId,id); child = {childId:id}; }
          db.exec('COMMIT'); reply(200, get.get(child.childId)); return;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const functionRoute = path.match(/^\/api\/functions(?:\/([a-zA-Z0-9-]{1,100}))?$/);
      if (functionRoute) {
        const functionId = functionRoute[1];
        if (req.method === 'GET' && !functionId) { reply(200, functions.all()); return; }
        if (req.method === 'DELETE' && functionId) {
          if (!deleteFunction.run(functionId).changes) { reply(404, {error:'Function not found.'}); return; }
          reply(200, {id:functionId}); return;
        }
        if ((req.method === 'POST' && !functionId) || (req.method === 'PUT' && functionId)) {
          if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, {error:'JSON required.'}); return; }
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1048576) { reply(413, {error:'Function too large.'}); return; } }
          let value; try { value=JSON.parse(body); } catch { reply(400, {error:'Invalid JSON.'}); return; }
          if (!value || Object.keys(value).sort().join() !== 'description,id,name,pseudocode' || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) || (functionId && value.id !== functionId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 10000 || typeof value.pseudocode !== 'string' || value.pseudocode.length > 500000) { reply(400, {error:'Invalid Function.'}); return; }
          if (req.method === 'POST') {
            if (findFunction.get(value.id)) { reply(409, {error:'Function already exists.'}); return; }
            insertFunction.run(value.id,value.name,value.description,value.pseudocode);
          } else if (!updateFunction.run(value.name,value.description,value.pseudocode,value.id).changes) { reply(404, {error:'Function not found.'}); return; }
          reply(req.method === 'POST' ? 201 : 200, findFunction.get(value.id)); return;
        }
        reply(405, {error:'Method not allowed.'}); return;
      }
      if (match && req.method === 'DELETE') {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM session_memory WHERE sessionId=?').run(match[1]);
          const memory = memoryChild.get(match[1]);
          if(memory){db.prepare('DELETE FROM memory_sessions WHERE parentId=?').run(match[1]);db.prepare('DELETE FROM session_memory WHERE sessionId=?').run(memory.childId);deleteHistory.run(memory.childId);deleteMetadata.run(memory.childId);pager.forget(memory.childId);}
          const child = slidingChild.get(match[1]);
          if (child) { db.prepare('DELETE FROM sliding_sessions WHERE parentId=?').run(match[1]); db.prepare('DELETE FROM session_memory WHERE sessionId=?').run(child.childId); deleteFacts.run(child.childId); deleteHistory.run(child.childId); deleteMetadata.run(child.childId); pager.forget(child.childId); }
          const sticky = stickyChild.get(match[1]);
          if (sticky) { db.prepare('DELETE FROM sticky_sessions WHERE parentId=?').run(match[1]); db.prepare('DELETE FROM session_memory WHERE sessionId=?').run(sticky.childId); deleteFacts.run(sticky.childId); deleteHistory.run(sticky.childId); deleteMetadata.run(sticky.childId); pager.forget(sticky.childId); }
          deleteFacts.run(match[1]);
          deleteHistory.run(match[1]);
          pager.forget(match[1]);
          deleteMetadata.run(match[1]);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        reply(200, { id: match[1], deleted: true }); return;
      }
      const factRoute = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/facts$/);
      if (factRoute) {
        const sessionId = factRoute[1];
        if (!get.get(sessionId)) { reply(404, {error:'Session not found.'}); return; }
        const read = () => { const row = getFacts.get(sessionId); return row ? {facts:JSON.parse(row.facts),coveredMessageId:row.coveredMessageId} : {facts:[],coveredMessageId:null}; };
        if (req.method === 'GET') { reply(200, read()); return; }
        if (req.method === 'PUT') {
          if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, {error:'JSON required.'}); return; }
          let body = '';
          for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1048576) { reply(413, {error:'Fact table too large.'}); return; } }
          let value; try { value=JSON.parse(body); } catch { reply(400, {error:'Invalid JSON.'}); return; }
          if (!value || Object.keys(value).sort().join() !== 'coveredMessageId,expectedCoveredMessageId,facts' || !Array.isArray(value.facts) || typeof value.coveredMessageId !== 'string' || !(value.expectedCoveredMessageId === null || typeof value.expectedCoveredMessageId === 'string') || value.facts.some(f => !f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).sort().join() !== 'attribute,subject,value' || ['subject','attribute','value'].some(k => typeof f[k] !== 'string' || !f[k].trim()))) { reply(400, {error:'Invalid fact table.'}); return; }
          const boundary = findEntity.get(sessionId, 'message', value.coveredMessageId);
          if (!boundary) { reply(400, {error:'Unknown coverage message.'}); return; }
          db.exec('BEGIN IMMEDIATE');
          try {
            if (read().coveredMessageId !== value.expectedCoveredMessageId) { db.exec('ROLLBACK'); reply(409, {error:'Fact table changed.'}); return; }
            const messages = history.all(sessionId).filter(row => row.type === 'message').map(row => JSON.parse(row.payload).id);
            if (messages.indexOf(value.coveredMessageId) <= (value.expectedCoveredMessageId === null ? -1 : messages.indexOf(value.expectedCoveredMessageId))) { db.exec('ROLLBACK'); reply(400, {error:'Coverage must advance.'}); return; }
            putFacts.run(sessionId, JSON.stringify(value.facts), value.coveredMessageId);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          reply(200, read()); return;
        }
      }
      const eventRoute = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/events$/);
      if (eventRoute) {
        const sessionId = eventRoute[1];
        if (!get.get(sessionId)) { reply(404, { error: 'Session not found.' }); return; }
        if (req.method === 'GET') {
          const search = new URL(req.url, 'http://localhost').searchParams;
          if(search.has('limit')) {
            try { reply(200, pager.page(sessionId, search)); }
            catch { reply(400, {error:'Invalid history page request.'}); }
            return;
          }
          reply(200, history.all(sessionId).map((row) => ({ ...row, payload: JSON.parse(row.payload) }))); return;
        }
        if (req.method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'JSON required.' }); return; }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 1048576) { reply(413, { error: 'History event too large.' }); return; }
          }
          if (!get.get(sessionId)) { reply(404, { error: 'Session not found.' }); return; }
          let event;
          try { event = JSON.parse(body); } catch { reply(400, { error: 'Invalid JSON.' }); return; }
          const payload = validateEvent(event, sessionId);
          if (!payload) { reply(400, { error: 'Invalid history event.' }); return; }
          const serialized = JSON.stringify(payload);
          const prior = existingEvent.get(event.id);
          if (prior) {
            if (prior.sessionId !== sessionId || prior.type !== event.type || prior.payload !== serialized) {
              reply(409, { error: 'Event ID conflict.' }); return;
            }
            reply(200, { ...prior, payload }); return;
          }
          if (event.type === 'context') {
            if (!findEntity.get(sessionId, 'run', payload.runId)) { reply(400, { error: 'Unknown run.' }); return; }
            if (payload.phase === 'completed') {
              const boundary = existingEvent.get(payload.coveredEventId);
              const rows = history.all(sessionId);
              if (!boundary || boundary.sessionId !== sessionId || payload.coveredRunIds.some((id) => {
                const latest = rows.filter((row) => row.type === 'run' && JSON.parse(row.payload).id === id).at(-1);
                return !latest || latest.sequence > boundary.sequence || JSON.parse(latest.payload).status !== 'completed' || id === payload.runId;
              })) { reply(400, { error: 'Invalid context history boundary.' }); return; }
            }
          }
          if (event.type === 'metering') {
            if (!findEntity.get(sessionId, 'run', payload.runId)) { reply(400, { error: 'Unknown run.' }); return; }
            const priorMeter = findEntity.get(sessionId, 'metering', payload.id);
            if (priorMeter) {
              const original = JSON.parse(priorMeter.payload);
              if (['requestKind', 'sentInputTokens', 'beforeInputTokens', 'afterInputTokens', 'compacted', 'sessionId', 'runId', 'toolExecutionOffset', 'provider', 'model', 'library', 'startedAt', 'encoding', 'estimatedInputTokens', 'pricing', 'estimatedInputCost'].some((key) => JSON.stringify(original[key]) !== JSON.stringify(payload[key]))) {
                reply(409, { error: 'Request meter identity or estimate changed.' }); return;
              }
            }
          }
          if (event.type.startsWith('tool-')) {
            if (!findEntity.get(sessionId, 'run', payload.runId)) { reply(400, { error: 'Unknown run.' }); return; }
            const call = findEntity.get(sessionId, 'tool-call', payload.id);
            if (event.type === 'tool-call' && call) { reply(409, { error: 'Call already recorded.' }); return; }
            if (event.type === 'tool-result') {
              const original = call && JSON.parse(call.payload);
              if (!original || original.runId !== payload.runId || original.toolCallId !== payload.toolCallId || original.toolId !== payload.toolId || JSON.stringify(original.arguments) !== JSON.stringify(payload.arguments)) {
                reply(400, { error: 'Result does not match a saved call.' }); return;
              }
              if (findEntity.get(sessionId, 'tool-result', payload.id)) { reply(409, { error: 'Result already recorded.' }); return; }
            }
          }
          // Synchronous transaction allocates a session-local sequence and makes retries idempotent.
          db.exec('BEGIN IMMEDIATE');
          try {
            addEvent.run(event.id, sessionId, sessionId, event.type, serialized);
            touch.run(Date.now(),sessionId);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          reply(201, { ...existingEvent.get(event.id), payload }); return;
        }
      }
      if (path === '/api/sessions' && req.method === 'GET') { reply(200, list.all()); return; }
      if (path === '/api/sessions' && req.method === 'POST') {
        const session = { id: randomUUID(), title: 'New session', createdAt: Date.now() };
        insert.run(session.id, session.title, session.createdAt);
        saveFullContext.run(1,session.id);
        reply(201, get.get(session.id)); return;
      }
      if (match && req.method === 'PATCH') {
        if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'JSON required.' }); return; }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) { reply(413, { error: 'Request too large.' }); return; }
        }
        let value;
        try { value = JSON.parse(body); } catch { reply(400, { error: 'Invalid JSON.' }); return; }
        if(value && Object.keys(value).length===1 && Object.hasOwn(value,'memorySelected')) {
          if(value.memorySelected!==0 && value.memorySelected!==1){reply(400,{error:'Invalid context mode.'});return;}
          if(!db.prepare('UPDATE sessions SET memorySelected=?,slidingSelected=CASE WHEN ?=1 THEN 0 ELSE slidingSelected END,stickySelected=CASE WHEN ?=1 THEN 0 ELSE stickySelected END WHERE id=?').run(value.memorySelected,value.memorySelected,value.memorySelected,match[1]).changes){reply(404,{error:'Session not found.'});return;}
          reply(200,get.get(match[1]));return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'slidingSelected')) {
          if (value.slidingSelected !== 0 && value.slidingSelected !== 1) { reply(400, {error:'Invalid context mode.'}); return; }
          if (!selectSliding.run(value.slidingSelected, value.slidingSelected, match[1]).changes) { reply(404, {error:'Session not found.'}); return; }
          reply(200, get.get(match[1])); return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'stickySelected')) {
          if (value.stickySelected !== 0 && value.stickySelected !== 1) {reply(400,{error:'Invalid context mode.'});return;}
          if (!selectSticky.run(value.stickySelected,value.stickySelected,match[1]).changes) {reply(404,{error:'Session not found.'});return;}
          reply(200,get.get(match[1]));return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'fullContext')) {
          if (value.fullContext !== 0 && value.fullContext !== 1) { reply(400, { error: 'Invalid context mode.' }); return; }
          if (!saveFullContext.run(value.fullContext, match[1]).changes) { reply(404, { error: 'Session not found.' }); return; }
          touch.run(Date.now(), match[1]); reply(200, get.get(match[1])); return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'contextStrategy')) {
          if (!['token-budget', 'key-facts'].includes(value.contextStrategy)) { reply(400, { error: 'Invalid context strategy.' }); return; }
          if (!saveStrategy.run(value.contextStrategy, match[1]).changes) { reply(404, { error: 'Session not found.' }); return; }
          touch.run(Date.now(), match[1]); reply(200, get.get(match[1])); return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'recentMessages')) {
          if (!Number.isSafeInteger(value.recentMessages) || value.recentMessages <= 0) { reply(400, { error: 'Recent messages must be a positive whole number.' }); return; }
          if (!saveRecent.run(value.recentMessages, match[1]).changes) { reply(404, { error: 'Session not found.' }); return; }
          touch.run(Date.now(), match[1]); reply(200, get.get(match[1])); return;
        }
        if (value && Object.keys(value).length === 1 && Object.hasOwn(value, 'requestTokenLimit')) {
          if (!Number.isSafeInteger(value.requestTokenLimit) || value.requestTokenLimit < 0) { reply(400, { error: 'Request token limit must be a non-negative whole number.' }); return; }
          if (!saveLimit.run(value.requestTokenLimit, match[1]).changes) { reply(404, { error: 'Session not found.' }); return; }
          touch.run(Date.now(),match[1]);
          reply(200, get.get(match[1])); return;
        }
        const title = typeof value?.title === 'string' ? value.title.trim() : '';
        if (!title || title.length > 200) { reply(400, { error: 'Title must contain 1–200 characters.' }); return; }
        if (!update.run(title, match[1]).changes) { reply(404, { error: 'Session not found.' }); return; }
        touch.run(Date.now(),match[1]);
        reply(200, get.get(match[1])); return;
      }
      reply(404, { error: 'Not found.' });
    } catch {
      reply(500, { error: 'Session storage operation failed.' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);let databasePath;let options={};let port=3003;
  if(args.length){
    if(![3,5].includes(args.length) || args[0]!=='--topic-mock' || args[1]!=='--db' || !args[2] || (args.length===5 && args[3]!=='--port'))throw new Error('Usage: node server/sessions.mjs [--topic-mock --db <temporary database path> [--port <port>]]');
    if(args.length===5){port=Number(args[4]);if(!Number.isSafeInteger(port) || port<0 || port>65535)throw new Error('Invalid backend port.');}
    if(process.env.NODE_ENV==='production')throw new Error('The topic mock is unavailable in production.');
    const { realpathSync, lstatSync, existsSync }=await import('node:fs');const { resolve, dirname, sep }=await import('node:path');const { tmpdir }=await import('node:os');
    databasePath=resolve(args[2]);const parent=realpathSync(dirname(databasePath));const roots=[realpathSync(tmpdir()),realpathSync('/tmp')];
    if(!roots.some(root=>parent===root || parent.startsWith(root+sep)) || (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()))throw new Error('The topic mock requires an isolated database under a temporary directory.');
    const mockProcessor=(await import('./dev-topic-mock.mjs')).processMockTopic;
    options={topicProcess:async(...parameters)=>{if(existsSync(databasePath+'.fail-topic'))throw new Error('Synthetic topic failure.');return mockProcessor(...parameters);},mockModel:true,
      mockSummaryFailure:()=>existsSync(databasePath+'.fail-summary'),
      credentialStore:{status:async()=>false,save:async()=>{throw new Error('Credentials are disabled in test mode.');},forget:async()=>{},read:async()=>{throw new Error('Credentials are disabled in test mode.');}},
      fetcher:async()=>{throw new Error('External provider requests are disabled in test mode.');}};
  }
  const server = createSessionServer(databasePath,options);
  server.listen(port, '127.0.0.1', () => console.log(`Session backend: http://127.0.0.1:${server.address().port}${args.length ? ' (synthetic topic mock)' : ''}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
