import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from './week3-sessions.mjs';
import { createContextProfileRepository } from './context-profile-repository.mjs';
import { resolveSessionPersonalization } from './session-personalization.mjs';
import { createSessionServer } from './sessions.mjs';

test('fresh snapshots use persisted session ownership and preserve each turn revision', () => {
  const db=new DatabaseSync(':memory:');
  try {
    createWeek3Routes(db,()=>null);const profiles=createContextProfileRepository(db);
    const profile=profiles.create('Synthetic','  First\npreference  ');
    db.prepare('INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES(?,?,?,?)').run('regular','Synthetic',1,profile.id);
    db.exec("INSERT INTO week3_sessions(id,title,createdAt) VALUES('general-session','General',2)");
    const first=resolveSessionPersonalization(db,'regular');assert.equal(first.ok,true);assert.deepEqual(first.data,{sessionId:'regular',profileId:profile.id,profileRevision:1,habits:'  First\npreference  '});
    assert.equal(Object.isFrozen(first.data),true);assert.throws(()=>{first.data.habits='changed';},TypeError);
    profiles.update(profile.id,'Synthetic','Second preference',1);
    assert.equal(first.data.habits,'  First\npreference  ');assert.equal(first.data.profileRevision,1);
    assert.deepEqual(resolveSessionPersonalization(db,'regular').data,{sessionId:'regular',profileId:profile.id,profileRevision:2,habits:'Second preference'});
    assert.deepEqual(resolveSessionPersonalization(db,'general-session').data,{sessionId:'general-session',profileId:'general',profileRevision:1,habits:''});
    assert.deepEqual(resolveSessionPersonalization(db,'missing'),{ok:false,error:'session_not_found'});
    assert.equal(db.prepare('SELECT count(*) AS n FROM week3_history_events').get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM week3_session_memory').get().n,0);
  } finally {db.close();}
});

test('missing profiles, corrupt associations and database failures remain distinct', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE week3_sessions(id TEXT,profile_id TEXT); CREATE TABLE context_profiles(id TEXT,revision INTEGER,habits TEXT,is_system INTEGER); INSERT INTO week3_sessions VALUES('missing-profile','absent'),('bad-id',NULL),('bad-revision','p'),('bad-general','general'); INSERT INTO context_profiles VALUES('p',0,'text',0),('general',1,'not empty',1)");
    for(const [id,error] of [['missing-profile','profile_not_found'],['bad-id','invalid_association'],['bad-revision','invalid_association'],['bad-general','invalid_association']]) assert.deepEqual(resolveSessionPersonalization(db,id),{ok:false,error});
    assert.deepEqual(resolveSessionPersonalization({prepare(){throw new Error('internal details');}},'x'),{ok:false,error:'database_error'});
  } finally {db.close();}
});

test('session-scoped HTTP snapshot resolves fresh data without accepting a profile override', async () => {
  const dir=await mkdtemp(join(tmpdir(),'d12-personalization-'));const server=createSessionServer(join(dir,'isolated.sqlite'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=(path,method='GET',body)=>fetch(base+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  try {
    const first=await (await request('/users','POST',{name:'First',habits:'one'})).json();
    const other=await (await request('/users','POST',{name:'Other',habits:'other'})).json();
    const session=await (await request('/week3/sessions','POST',{profileId:first.id})).json();
    let response=await request(`/week3/sessions/${session.id}/profile?profileId=${other.id}`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual((await response.json()).data,{sessionId:session.id,profileId:first.id,profileRevision:1,habits:'one'});
    response=await request(`/users/${first.id}`,'PATCH',{name:'First',habits:'two',expectedRevision:1});assert.equal(response.status,200);
    response=await request(`/week3/sessions/${session.id}/profile`);assert.equal(response.status,200);assert.equal((await response.json()).data.habits,'two');
    response=await request('/week3/sessions/nonexistent/profile');assert.equal(response.status,404);assert.deepEqual(await response.json(),{ok:false,error:'session_not_found'});
  } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
