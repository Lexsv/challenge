import { createHistoryPager } from './history-pages.mjs';
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
  const credentialRoutes = createCredentialRoutes(options.credentialStore, options.fetcher);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
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
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'updatedAt')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET updatedAt = MAX(createdAt, COALESCE((SELECT MAX(COALESCE(json_extract(payload,'$.endedAt'), json_extract(payload,'$.createdAt'), json_extract(payload,'$.startedAt'),0)) FROM history_events WHERE sessionId = sessions.id),0));`);
  }
  const touch = db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?');
  const saveLimit = db.prepare('UPDATE sessions SET requestTokenLimit = ? WHERE id = ?');
  const saveStrategy = db.prepare('UPDATE sessions SET contextStrategy = ? WHERE id = ?');
  const saveRecent = db.prepare('UPDATE sessions SET recentMessages = ? WHERE id = ?');
  const list = db.prepare('SELECT id, title, createdAt, requestTokenLimit, contextStrategy, recentMessages, updatedAt FROM sessions ORDER BY createdAt, rowid');
  const get = db.prepare('SELECT id, title, createdAt, requestTokenLimit, contextStrategy, recentMessages FROM sessions WHERE id = ?');
  const insert = db.prepare('INSERT INTO sessions (id, title, createdAt, requestTokenLimit) VALUES (?, ?, ?, 0)');
  const deleteHistory = db.prepare('DELETE FROM history_events WHERE sessionId = ?');
  const deleteFacts = db.prepare('DELETE FROM session_facts WHERE sessionId = ?');
  const getFacts = db.prepare('SELECT facts, coveredMessageId FROM session_facts WHERE sessionId = ?');
  const putFacts = db.prepare('INSERT INTO session_facts (sessionId, facts, coveredMessageId) VALUES (?, ?, ?) ON CONFLICT(sessionId) DO UPDATE SET facts=excluded.facts, coveredMessageId=excluded.coveredMessageId');
  const deleteMetadata = db.prepare('DELETE FROM sessions WHERE id = ?');
  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
  const history = db.prepare('SELECT id, sessionId, sequence, type, payload FROM history_events WHERE sessionId = ? ORDER BY sequence');
  const pager = createHistoryPager(db);
  const existingEvent = db.prepare('SELECT * FROM history_events WHERE id = ?');
  const findEntity = db.prepare("SELECT payload FROM history_events WHERE sessionId = ? AND type = ? AND json_extract(payload, '$.id') = ? ORDER BY sequence LIMIT 1");
  const addEvent = db.prepare('INSERT INTO history_events (id, sessionId, sequence, type, payload) VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM history_events WHERE sessionId = ?), ?, ?)');
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
      if (await credentialRoutes(req, path, reply)) return;
      if (match && req.method === 'DELETE') {
        db.exec('BEGIN IMMEDIATE');
        try {
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
  const server = createSessionServer();
  server.listen(3001, '127.0.0.1', () => console.log('Session backend: http://127.0.0.1:3001'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
