import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSessionServer} from './sessions.mjs';

test('persists Function CRUD and exact pseudocode across restart on an existing database',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'d9-functions-')),path=join(folder,'test.sqlite');
 const old=new DatabaseSync(path);old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL); INSERT INTO sessions VALUES ('existing','Existing',1)");old.close();
 let server,url;
 const start=async()=>{server=createSessionServer(path,{credentialStore:{status:async()=>false,read:async()=>{throw Error('Empty fake store')},save:async()=>{},forget:async()=>{}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;};
 const stop=()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 const api=(path,method='GET',body)=>fetch(url+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  await start();assert.deepEqual(await (await api('/api/functions')).json(),[]);
  const first={id:'function-1',name:'Discount',description:'Computes a discount.',pseudocode:'input price\n  return price * 0.9\n'};
  assert.equal((await api('/api/functions','POST',first)).status,201);
  assert.equal((await api('/api/functions','POST',first)).status,409);
  assert.equal((await api('/api/functions','POST',{...first,id:'bad',name:' '})).status,400);
  await stop();await start();assert.deepEqual(await (await api('/api/functions')).json(),[first]);
  assert.equal((await (await api('/api/sessions')).json())[0].id,'existing');
  const edited={...first,name:'Discount revised',description:'Updated.',pseudocode:' raw \n\treturn 42\n'};
  assert.equal((await api('/api/functions/function-1','PUT',edited)).status,200);
  assert.deepEqual(await (await api('/api/functions')).json(),[edited]);
  assert.equal((await api('/api/functions/function-1','DELETE')).status,200);
  await stop();await start();assert.deepEqual(await (await api('/api/functions')).json(),[]);
 }finally{if(server?.listening)await stop();await rm(folder,{recursive:true,force:true});}
});
