import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContextProfileRepository, GENERAL_PROFILE_ID } from './context-profile-repository.mjs';
import { createSessionServer } from './sessions.mjs';

test('initializes idempotently and preserves an existing database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE existing_data (value TEXT NOT NULL); INSERT INTO existing_data VALUES ('preserved')");
    const first = createContextProfileRepository(db), second = createContextProfileRepository(db);
    assert.deepEqual(first.list().map(row => ({...row})), [{id:'general',name:'General',habits:'',is_system:1,revision:1}]);
    assert.equal(second.get(GENERAL_PROFILE_ID).name, 'General');
    assert.equal(db.prepare('SELECT value FROM existing_data').get().value, 'preserved');
  } finally { db.close(); }
});

test('creates, reads, updates and deletes regular profiles with revision checks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const profiles = createContextProfileRepository(db);
    const first = profiles.create(' Alex ', 'Detailed examples');
    const second = profiles.create('Developer');
    assert.notEqual(first.id, second.id); assert.equal(first.name, 'Alex'); assert.equal(second.habits, '');
    assert.equal(profiles.get(first.id).habits, 'Detailed examples');
    const updated = profiles.update(first.id, 'Alex Smith', 'Short answers', first.revision);
    assert.equal(updated.revision, 2); assert.equal(updated.habits, 'Short answers');
    assert.throws(() => profiles.update(first.id, 'Stale', '', first.revision), /revision conflict/);
    assert.equal(profiles.get(first.id).name, 'Alex Smith');
    assert.equal(profiles.delete(second.id), true); assert.equal(profiles.delete(second.id), false);
    assert.equal(profiles.get(second.id), null);
    assert.throws(() => profiles.create('  '), /Invalid/);
    assert.throws(() => profiles.create('general'), /Invalid/);
  } finally { db.close(); }
});

test('protects General and validates SQLite constraints at the persistence boundary', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const profiles = createContextProfileRepository(db);
    assert.throws(() => profiles.update('general', 'Other', '', 1), /immutable/);
    assert.throws(() => profiles.delete('general'), /cannot be deleted/);
    assert.throws(() => db.prepare("UPDATE context_profiles SET habits = 'changed' WHERE id = 'general'").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM context_profiles WHERE id = 'general'").run(), /cannot be deleted/);
    assert.throws(() => db.prepare("INSERT INTO context_profiles VALUES ('other', 'Other', '', 1, 1)").run());
    assert.throws(() => db.prepare("INSERT INTO context_profiles VALUES ('other', 'Other', '', 0, 0)").run());
    assert.equal(profiles.list().length, 1);
  } finally { db.close(); }
});

test('restores profiles and revisions after reopening SQLite', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd12-profile-test-'));
  const path = join(folder, 'isolated.sqlite'); let db;
  try {
    db = new DatabaseSync(path); const profiles = createContextProfileRepository(db);
    const created = profiles.create('Alex', 'Likes examples'); profiles.update(created.id, 'Alex', 'Likes diagrams', 1);
    db.close(); db = new DatabaseSync(path);
    const restored = createContextProfileRepository(db);
    assert.equal(restored.get(created.id).habits, 'Likes diagrams');
    assert.equal(restored.get(created.id).revision, 2);
    assert.equal(restored.list().filter(profile => profile.is_system === 1).length, 1);
  } finally { db?.close(); await rm(folder, {recursive:true,force:true}); }
});

test('the existing session server initializes profiles without changing existing session rows', async () => {
  const folder=await mkdtemp(join(tmpdir(),'d12-profile-server-')); const path=join(folder,'isolated.sqlite');
  let db=new DatabaseSync(path);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL); INSERT INTO sessions VALUES ('existing', 'Existing session', 1)");
  db.close(); let server;
  try {
    server=createSessionServer(path);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    db=new DatabaseSync(path,{readOnly:true});
    try {
      assert.equal(db.prepare('SELECT title FROM sessions WHERE id=?').get('existing').title,'Existing session');
      assert.equal(db.prepare('SELECT count(*) AS n FROM context_profiles WHERE is_system=1').get().n,1);
    } finally {db.close();}
  } finally {
    if(server?.listening) await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(folder,{recursive:true,force:true});
  }
});
