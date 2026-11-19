import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from './week3-sessions.mjs';
import { createTopicRepository } from './topic-repository.mjs';
import { initializeWeek3ProfileReference } from './week3-profile-migration.mjs';

const database = () => new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'd12-profile-migration-')), 'test.sqlite'));
const initialize = db => createWeek3Routes(db, () => null);
const rows = (db, name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();

test('fresh database enforces default, foreign key, immutable profile and repeat initialization', () => {
  const db = database(); initialize(db); initialize(db);
  db.exec("INSERT INTO context_profiles VALUES ('alice','Alice','',0,1); INSERT INTO week3_sessions(id,title,createdAt) VALUES ('a','A',1); INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES ('b','B',2,'alice')");
  assert.equal(db.prepare("SELECT profile_id FROM week3_sessions WHERE id='a'").get().profile_id, 'general');
  assert.equal(db.prepare("SELECT profile_id FROM week3_sessions WHERE id='b'").get().profile_id, 'alice');
  assert.throws(() => db.exec("INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES ('c','C',3,'missing')"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES ('c','C',3,NULL)"), /NOT NULL/);
  assert.throws(() => db.exec("UPDATE week3_sessions SET profile_id='general' WHERE id='b'"), /immutable/);
  assert.throws(() => db.exec("INSERT OR REPLACE INTO week3_sessions(id,title,createdAt,profile_id) VALUES ('b','B',2,'general')"), /immutable/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM context_profiles WHERE is_system=1").get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('legacy session, archive, snapshot and topic records survive migration and reopen', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'd12-profile-reopen-')), 'test.sqlite');
  let db = new DatabaseSync(path);
  db.exec(`CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL DEFAULT 0,requestTokenLimit INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE week3_history_events(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES week3_sessions(id),sequence INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),UNIQUE(sessionId,sequence));
    CREATE TABLE week3_session_memory(sessionId TEXT PRIMARY KEY REFERENCES week3_sessions(id),revision INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL CHECK(json_valid(data)));
    INSERT INTO week3_sessions VALUES ('s','Legacy',1,2,42);
    INSERT INTO week3_history_events VALUES ('e','s',1,'message','{}');
    INSERT INTO week3_session_memory VALUES ('s',2,'{"summary":"legacy"}');`);
  createTopicRepository(db);
  db.exec(`INSERT INTO week3_topics VALUES ('s','topic','value','confirmed',1);
    INSERT INTO week3_topic_changes VALUES ('s','topic',1,'m','creation',NULL,'value','confirmed','fact',1,0);
    INSERT INTO week3_topic_evidence VALUES ('s','topic',1,'msg','user',1,'text',1);
    INSERT INTO week3_topic_segments VALUES ('s','segment','[]');`);
  const tables = ['week3_sessions','week3_history_events','week3_session_memory','week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments'];
  const before = Object.fromEntries(tables.map(name => [name, rows(db,name)]));
  initialize(db); initialize(db);
  const session = rows(db,'week3_sessions')[0]; assert.equal(session.profile_id,'general');
  const { profile_id, ...original } = session; assert.deepEqual(original,{...before.week3_sessions[0]});
  for (const table of tables.slice(1)) assert.deepEqual(rows(db,table),before[table]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close(); db = new DatabaseSync(path); initialize(db);
  for (const table of tables.slice(1)) assert.deepEqual(rows(db,table),before[table]);
  assert.equal(rows(db,'week3_sessions')[0].profile_id,'general');
  db.close();
});


test('unexpected dependent schema aborts without changing archived data', () => {
  const db = database();
  db.exec("CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL DEFAULT 0,requestTokenLimit INTEGER NOT NULL DEFAULT 0); INSERT INTO week3_sessions VALUES ('s','Safe',1,0,0); CREATE TABLE unknown_child(id TEXT REFERENCES week3_sessions(id) ON DELETE CASCADE); INSERT INTO unknown_child VALUES ('s')");
  assert.throws(() => initialize(db), /Unsupported dependent table/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM week3_sessions').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM unknown_child').get().n,1);
  assert.equal(db.prepare('PRAGMA table_info(week3_sessions)').all().some(c => c.name === 'profile_id'),false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('mixed-case cascade dependency is rejected before deletes with schema and rows unchanged', () => {
  const db = database();
  db.exec("CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL DEFAULT 0,requestTokenLimit INTEGER NOT NULL DEFAULT 0); INSERT INTO week3_sessions VALUES ('s','Safe',1,0,0); CREATE TABLE unknown_child(id TEXT REFERENCES WEEK3_SESSIONS(id) ON DELETE CASCADE); INSERT INTO unknown_child VALUES ('s')");
  const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const beforeSchema = schema(), beforeSessions = rows(db, 'week3_sessions'), beforeChild = rows(db, 'unknown_child');
  let destructiveCalls = 0;
  const tracked = { prepare: db.prepare.bind(db), exec(sql) { if (/^\s*(DELETE|DROP|ALTER)\b/i.test(sql)) destructiveCalls++; return db.exec(sql); } };
  assert.throws(() => initializeWeek3ProfileReference(tracked), /Unsupported dependent table/);
  assert.equal(destructiveCalls, 0);
  assert.deepEqual(schema(), beforeSchema);
  assert.deepEqual(rows(db, 'week3_sessions'), beforeSessions);
  assert.deepEqual(rows(db, 'unknown_child'), beforeChild);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('failure after staging and deletion rolls back schema and records', () => {
  const db = database();
  db.exec("CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL DEFAULT 0,requestTokenLimit INTEGER NOT NULL DEFAULT 0); INSERT INTO week3_sessions VALUES ('s','Safe',1,0,0)");
  const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const beforeSchema = schema(), beforeSessions = rows(db, 'week3_sessions');
  let injected = false;
  const failing = { prepare: db.prepare.bind(db), exec(sql) {
    if (sql.startsWith('ALTER TABLE week3_sessions ADD COLUMN')) {
      assert.equal(db.prepare('SELECT count(*) AS n FROM week3_sessions').get().n, 0);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      injected = true;
      throw new Error('injected migration failure');
    }
    return db.exec(sql);
  } };
  assert.throws(() => initializeWeek3ProfileReference(failing), /injected migration failure/);
  assert.equal(injected, true);
  assert.deepEqual(schema(), beforeSchema);
  assert.deepEqual(rows(db, 'week3_sessions'), beforeSessions);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
