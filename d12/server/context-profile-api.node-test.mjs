import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from './sessions.mjs';

test('profile API validates, protects General, checks revisions and survives restart', async () => {
  const folder=await mkdtemp(join(tmpdir(),'d12-profile-api-')); const path=join(folder,'isolated.sqlite'); let server,base;
  const start=async()=>{server=createSessionServer(path);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;};
  const stop=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const api=(suffix,method='GET',body)=>fetch(`${base}/api/users${suffix}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  try {
    await start();
    let result=await api('');assert.equal(result.status,200);assert.deepEqual(await result.json(),[{id:'general',name:'General',habits:'',is_system:1,revision:1}]);
    assert.equal((await api('/general')).status,200);
    for(const payload of [{},{name:''},{name:'General'},{name:'Alex',habits:null},{name:'Alex',habits:3},{name:'Alex',is_system:1},{name:'x'.repeat(201)}]) assert.equal((await api('','POST',payload)).status,400);
    assert.equal((await fetch(`${base}/api/users`,{method:'POST',body:'{'})).status,400);
    assert.equal((await api('/not-valid')).status,400);
    const missing='/00000000-0000-0000-0000-000000000001';
    assert.equal((await api(missing)).status,404);assert.equal((await api(missing,'DELETE')).status,404);
    assert.equal((await api(missing,'PATCH',{name:'Alex',habits:'',expectedRevision:1})).status,404);
    assert.equal((await api('/general','PATCH',{name:'Other',habits:'',expectedRevision:1})).status,403);
    assert.equal((await api('/general','DELETE')).status,403);
    result=await api('','POST',{name:'Developer'});assert.equal(result.status,201);const defaultProfile=await result.json();assert.equal(defaultProfile.habits,'');
    assert.equal((await api(`/${defaultProfile.id}`,'DELETE')).status,200);
    result=await api('','POST',{name:'Alex',habits:'Detailed'});assert.equal(result.status,201);let profile=await result.json();assert.equal(profile.revision,1);assert.equal(profile.is_system,0);
    const uri=`/${profile.id}`;
    assert.equal((await api(uri,'PATCH',{name:'Alex',habits:'Brief'})).status,400);
    assert.equal((await api(uri,'PATCH',{name:'Alex',habits:'Brief',expectedRevision:0})).status,400);
    assert.equal((await api(uri,'PATCH',{name:'Alex',habits:'Brief',expectedRevision:2})).status,409);
    result=await api(uri,'PATCH',{name:'Alex',habits:'Brief',expectedRevision:1});assert.equal(result.status,200);profile=await result.json();assert.equal(profile.revision,2);
    await stop();await start();result=await api(uri);assert.equal(result.status,200);assert.equal((await result.json()).habits,'Brief');
    result=await api(uri,'DELETE');assert.equal(result.status,200);assert.deepEqual(await result.json(),{id:profile.id,deleted:true});assert.equal((await api(uri)).status,404);
    assert.equal((await api('/general')).status,200);
  } finally {if(server?.listening)await stop();await rm(folder,{recursive:true,force:true});}
});
