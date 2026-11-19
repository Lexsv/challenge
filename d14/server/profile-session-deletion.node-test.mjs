import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from './sessions.mjs';
import { createContextProfileRepository } from './context-profile-repository.mjs';
import { createWeek3Routes } from './week3-sessions.mjs';

test('profile session deletion refuses to run with foreign keys disabled', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const profiles = createContextProfileRepository(db);
    db.exec('PRAGMA foreign_keys=OFF');
    assert.throws(() => profiles.clearGeneralSessions(), /requires foreign keys/);
    assert.throws(() => profiles.deleteWithSessions('missing'), /requires foreign keys/);
    assert.equal(profiles.get('general').name, 'General');
  } finally { db.close(); }
});

test('unknown mixed-case cascade and unknown triggers block both deletion operations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createWeek3Routes(db, () => null);
    const profiles = createContextProfileRepository(db), a = profiles.create('A'), b = profiles.create('B');
    const insert = db.prepare('INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES(?,?,?,?)');
    insert.run('a','A',1,a.id); insert.run('b','B',2,b.id); insert.run('g','General',3,'general');
    db.exec("CREATE TABLE external_data(owner TEXT REFERENCES week3_sessions(id), dependency TEXT REFERENCES WEEK3_SESSIONS(id) ON DELETE CASCADE, value TEXT); INSERT INTO external_data VALUES ('b','a','B data')");
    assert.throws(() => profiles.deleteWithSessions(a.id), /Unsupported profile deletion dependency/);
    assert.throws(() => profiles.clearGeneralSessions(), /Unsupported profile deletion dependency/);
    assert.equal(db.prepare('SELECT value FROM external_data WHERE owner=?').get('b').value,'B data');
    assert.deepEqual(db.prepare('SELECT id FROM week3_sessions ORDER BY id').all().map(row=>row.id),['a','b','g']);
    assert.ok(profiles.get(a.id)); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('DROP TABLE external_data');
    db.exec('CREATE TEMP TRIGGER unexpected BEFORE DELETE ON week3_sessions BEGIN SELECT 1; END');
    assert.throws(() => profiles.deleteWithSessions(a.id), /Unsupported profile deletion trigger/);
    assert.throws(() => profiles.clearGeneralSessions(), /Unsupported profile deletion trigger/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM week3_sessions').get().n,3);
    assert.ok(profiles.get(a.id)); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('DROP TRIGGER temp.unexpected');
    db.exec('ALTER TABLE week3_session_memory ADD COLUMN extra TEXT REFERENCES context_profiles(id) ON DELETE CASCADE');
    assert.throws(() => profiles.deleteWithSessions(a.id), /Unsupported profile deletion dependency/);
    assert.throws(() => profiles.clearGeneralSessions(), /Unsupported profile deletion dependency/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM week3_sessions').get().n,3);
  } finally { db.close(); }
});

test('a failure after session deletion rolls back all changes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createWeek3Routes(db, () => null);
    const wrapped = {
      exec:db.exec.bind(db),
      prepare(sql) {
        const statement=db.prepare(sql);
        if (sql === 'DELETE FROM context_profiles WHERE id = ? AND is_system = 0') return { run() { throw new Error('injected failure'); } };
        return statement;
      },
    };
    const profiles=createContextProfileRepository(wrapped), profile=profiles.create('Rollback');
    db.prepare('INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES(?,?,?,?)').run('session','Title',1,profile.id);
    db.exec("INSERT INTO week3_history_events VALUES('event','session',1,'message','{}'); INSERT INTO week3_session_memory VALUES('session',1,'{}')");
    assert.throws(() => profiles.deleteWithSessions(profile.id), /injected failure/);
    assert.ok(profiles.get(profile.id));
    for (const table of ['week3_sessions','week3_history_events','week3_session_memory']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
});

test('profile deletion and General clearing are atomic and session-scoped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd12-profile-delete-'));
  const path = join(dir, 'isolated.sqlite');
  const server = createSessionServer(path);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const api = (path, method = 'GET', body) => fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const createProfile = async name => (await (await api('/users', 'POST', {name})).json()).id;
  const createSession = async profileId => (await (await api('/week3/sessions', 'POST', {profileId})).json()).id;
  const db = new DatabaseSync(path);
  const seed = id => {
    db.prepare('INSERT INTO week3_history_events VALUES(?,?,1,?,?)').run(`event-${id}`,id,'message','{}');
    db.prepare('INSERT INTO week3_session_memory VALUES(?,1,?)').run(id,'{}');
    db.prepare('INSERT INTO week3_topics VALUES(?,?,?,?,1)').run(id,'topic','value','confirmed');
    db.prepare('INSERT INTO week3_topic_changes VALUES(?,?,1,?,?,?,?,?,?,?,?)').run(id,'topic','mutation','creation',null,'value','confirmed','fact',1,0);
    db.prepare('INSERT INTO week3_topic_evidence VALUES(?,?,1,?,?,?,?,?)').run(id,'topic',`message-${id}`,'user',1,'text',1);
    db.prepare('INSERT INTO week3_topic_segments VALUES(?,?,?)').run(id,'segment','[]');
  };
  const tables = ['week3_sessions','week3_history_events','week3_session_memory','week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments'];
  const count = (table, id) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === 'week3_sessions' ? 'id' : table === 'week3_history_events' || table === 'week3_session_memory' ? 'sessionId' : 'session_id'}=?`).get(id).n;
  try {
    const target = await createProfile('Target'), other = await createProfile('Other'), empty = await createProfile('Empty'), failing = await createProfile('Failure');
    const target1 = await createSession(target), target2 = await createSession(target), survivor = await createSession(other), general = await createSession('general'), retry = await createSession(failing);
    for (const id of [target1,target2,survivor,general,retry]) seed(id);
    let response = await api('/users/general', 'DELETE'); assert.equal(response.status, 403);
    response = await api(`/users/${target}`, 'DELETE'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), {id:target,deleted:true,sessionsDeleted:2});
    for (const table of tables) for (const id of [target1,target2]) assert.equal(count(table,id),0,`${table} ${id}`);
    for (const table of tables) for (const id of [survivor,general,retry]) assert.equal(count(table,id),1,`${table} ${id}`);
    assert.equal((await api(`/users/${target}`)).status,404); assert.equal((await api(`/users/${other}`)).status,200);
    response = await api(`/users/${empty}`, 'DELETE'); assert.equal(response.status,200); assert.equal((await response.json()).sessionsDeleted,0);
    response = await fetch(`${base}/users/general/sessions`, {method:'DELETE', headers:{Origin:'http://example.invalid'}}); assert.equal(response.status,403);
    response = await api('/users/general/sessions','DELETE'); assert.equal(response.status,200); assert.deepEqual(await response.json(),{id:'general',sessionsDeleted:1});
    assert.equal((await api('/users/general')).status,200);
    for (const table of tables) { assert.equal(count(table,general),0); assert.equal(count(table,survivor),1); }
    db.exec(`CREATE TRIGGER injected_delete_failure BEFORE DELETE ON context_profiles WHEN OLD.id='${failing}' BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    response = await api(`/users/${failing}`,'DELETE'); assert.equal(response.status,500);
    for (const table of tables) assert.equal(count(table,retry),1,`${table} after rollback`);
    assert.equal((await api(`/users/${failing}`)).status,200);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('DROP TRIGGER injected_delete_failure');
    response = await api(`/users/${failing}`,'DELETE'); assert.equal(response.status,200); assert.equal((await response.json()).sessionsDeleted,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal((await api(`/week3/sessions/${survivor}`)).status,200);
  } finally {
    db.close(); await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
