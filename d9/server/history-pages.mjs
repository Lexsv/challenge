import { getEncoding } from 'js-tiktoken';

// Pages are whole runs, identified by their first saved event. A snapshot keeps
// cursors stable while later events are appended; the unpaged API remains for Manager.
export function createHistoryPager(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS history_run_pages ON history_events
    (sessionId, COALESCE(json_extract(payload, '$.runId'), json_extract(payload, '$.id')), sequence)`);
  const maximum = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM history_events WHERE sessionId = ?');
  const runs = db.prepare(`SELECT COALESCE(json_extract(payload, '$.runId'), json_extract(payload, '$.id')) AS runId, MIN(sequence) AS first
    FROM history_events WHERE sessionId = ? AND sequence <= ? GROUP BY runId HAVING MIN(sequence) < ? ORDER BY first DESC LIMIT ?`);
  const rows = db.prepare(`SELECT id, sessionId, sequence, type, payload FROM history_events WHERE sessionId = ? AND sequence <= ?
    AND COALESCE(json_extract(payload, '$.runId'), json_extract(payload, '$.id')) IN (SELECT value FROM json_each(?)) ORDER BY sequence`);
  const accounting = db.prepare("SELECT id, sessionId, sequence, type, payload FROM history_events WHERE sessionId = ? AND sequence <= ? AND type IN ('run', 'metering') ORDER BY sequence");
  const dialogue = db.prepare("SELECT type, payload FROM history_events WHERE sessionId = ? AND sequence <= ? AND type IN ('message','tool-call','tool-result') ORDER BY sequence");
  const encoders = new Map();
  const cache = new Map();
  const decode = row => ({...row, payload: JSON.parse(row.payload)});
  function totals(sessionId, snapshot) {
    const prior = cache.get(sessionId);
    if (prior?.snapshot === snapshot) return prior.value;
    const messages = [], tools = new Map();
    for (const row of dialogue.all(sessionId, snapshot)) {
      const payload = JSON.parse(row.payload);
      if (row.type === 'message') { if (payload.role !== 'system') messages.push({role: payload.role, content: payload.text}); }
      else tools.set(payload.id, payload);
    }
    for (const tool of tools.values()) {
      // Match restoration's incomplete-call representation without running anything.
      const incomplete = !tool.endedAt;
      messages.push({role:'assistant', content:`Saved tool observation (data only): ${JSON.stringify({toolId:tool.toolId,arguments:tool.arguments,status:incomplete?'incomplete':tool.status,output:tool.output,error:incomplete?'Incomplete: no saved result. This call was not replayed.':tool.error})}`});
    }
    const dialogueTokens = {};
    for (const name of ['o200k_base', 'cl100k_base']) {
      if (!encoders.has(name)) encoders.set(name, getEncoding(name));
      dialogueTokens[name] = messages.length ? encoders.get(name).encode(JSON.stringify(messages), [], []).length : 0;
    }
    const value = {accountingEvents:accounting.all(sessionId,snapshot).map(decode),dialogueTokens};
    // Only one numeric/accounting snapshot per session; never cache dialogue text.
    cache.set(sessionId,{snapshot,value});
    return value;
  }
  return {
    forget: id => cache.delete(id),
    page(sessionId, search) {
      const number = (name, fallback) => {
        const raw = search.get(name); if(raw === null)return fallback;
        if(!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))throw Error('Invalid page cursor.');return Number(raw);
      };
      const limit = number('limit', 20);
      if(limit < 1 || limit > 50)throw Error('Invalid page size.');
      const snapshot = number('snapshot',maximum.get(sessionId).value);
      const before = number('before',Number.MAX_SAFE_INTEGER);
      const selected = runs.all(sessionId,snapshot,before,limit+1);
      const chosen=selected.slice(0,limit);
      return {events:rows.all(sessionId,snapshot,JSON.stringify(chosen.map(row=>row.runId))).map(decode),
        nextBefore:selected.length>limit?chosen.at(-1).first:null,snapshot,
        // Aggregate metadata is sent once, not on every older page.
        ...(search.has('before')?{}:totals(sessionId,snapshot))};
    },
  };
}
