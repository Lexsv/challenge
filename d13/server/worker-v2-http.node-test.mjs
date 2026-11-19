import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionServer} from './sessions.mjs';

const mockEvaluation=async ({state,snapshot})=>{
 const findings=state.results.map((item,i)=>({stepId:item.stepId,
   passed:item.result.type==='question'?item.result.optionId===snapshot.document.steps[i].evaluation.optionId:item.result.status==='completed',
   reason:'Reviewed.',evidence:item.result.type==='question'?item.result.optionId:item.result.status==='problem'?item.result.reason:'Completed'}));
 const errorCount=findings.filter(f=>!f.passed).length;
 return {ok:true,evaluation:{success:!errorCount,reason:'Evaluation complete.',errorCount,findings}};
};
test('V2 HTTP sessions collect, evaluate, complete, and survive restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'worker-v2-http-'));let server;const path=join(dir,'test.sqlite');let calls=0;
 const boot=async()=>{server=createSessionServer(path,{workerEvaluator:async data=>{calls++;return mockEvaluation(data);}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;};
 try{
  let base=await boot();
  const get=async path=>{const response=await fetch(base+path);return {status:response.status,body:await response.json()};};
  const post=async(path,value)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});return {status:response.status,body:await response.json()};};
  for(const templateId of ['quiz-v2','chocolate-v2']){
   const created=await post('/api/worker-sessions',{name:templateId,profileId:'general',templateId});assert.equal(created.status,201);const sid=created.body.id;
   assert.equal(JSON.stringify(created.body).includes('correct_option'),false);assert.equal(JSON.stringify(created.body).includes('acceptance_criteria'),false);
   const url=`/api/worker-sessions/${sid}`, status=()=>get(`${url}/status`);let rev=1,n=0;
   assert.equal((await post(`${url}/actions`,{requestId:'forged',expectedRevision:1,action:'validate',payload:{success:true}})).status,400);
   assert.equal((await post(`${url}/actions`,{requestId:'overflow',expectedRevision:1e400,action:'start',payload:{}})).status,400);
   const numericOverflow=await fetch(base+`${url}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"requestId":"overflow-json","expectedRevision":1e400,"action":"start","payload":{}}'});assert.equal(numericOverflow.status,400);
   const command=async(action,payload={})=>{const result=await post(`${url}/actions`,{requestId:`r-${++n}`,expectedRevision:rev,action,payload});assert.equal(result.status,200,JSON.stringify(result));rev++;return result;};
   const early={requestId:'early-validation',expectedRevision:1,action:'validate',payload:{}};
   assert.equal((await post(`${url}/actions`,early)).body.code,'invalid_transition');
   await command('start');
   const earlyReplay=await post(`${url}/actions`,early);assert.equal(earlyReplay.body.code,'invalid_transition');assert.equal(earlyReplay.body.replayed,true);
   assert.equal((await post(`${url}/actions`,{requestId:'skip',expectedRevision:rev,action:'next',payload:{}})).body.code,'invalid_transition');
   for(let i=0;i<5;i++){
    const result=templateId==='quiz-v2'?{type:'question',optionId:'option-1'}:{type:'action',status:i===2?'problem':'completed',...(i===2?{reason:'Damaged beans'}:{})};
    await command('submit',{result});
    if(templateId==='quiz-v2' && i===0)await command('correct',{result:{type:'question',optionId:'option-2'}});
    if(templateId==='chocolate-v2' && i===2){await command('back');await command('submit',{result:{type:'action',status:'completed'}});await command('next');await command('submit',{result:{type:'action',status:'completed'}});}
    if(i<4)await command('next');
   }
   assert.equal(calls,templateId==='quiz-v2'?0:1);const before=await status();assert.ok(before.body.availableActions.includes('validate'));
   const validation={requestId:`r-${++n}`,expectedRevision:rev,action:'validate',payload:{}};
   assert.equal((await post(`${url}/actions`,validation)).status,200);rev++;
   const replay=await post(`${url}/actions`,validation);assert.equal(replay.body.replayed,true);assert.equal(calls,templateId==='quiz-v2'?1:2);
   const report=await status();assert.equal(report.body.evaluation.findings.length,5);assert.equal(JSON.stringify(report.body.session).includes('correct_option'),false);
   await command('complete');const done=await status();assert.equal(done.body.completion,templateId==='quiz-v2'?'completed_with_errors':'passed');if(templateId==='chocolate-v2'){assert.ok(done.body.submissions.some(item=>item.result.status==='problem'));assert.equal(done.body.results[2].result.status,'completed');}else{assert.equal(done.body.submissions.filter(item=>item.stepId==='step-1').length,2);assert.equal(done.body.results[0].result.optionId,'option-2');}
   await new Promise(resolve=>server.close(resolve));base=await boot();
   const restored=await status();assert.equal(restored.body.session.state,'completed');assert.deepEqual(restored.body.evaluation,done.body.evaluation);
  }
 }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('trusted adapter uses server criteria and rejects a stale evaluation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'worker-v2-provider-'));let server,release,entered;const gate=new Promise(resolve=>{release=resolve;}), arrived=new Promise(resolve=>{entered=resolve;});let providerCalls=0;
 try{
  server=createSessionServer(join(dir,'test.sqlite'),{instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},workerValidatorTransport:async(_provider,body)=>{
   providerCalls++;entered();await gate;
   const message=body.input.find(item=>item.role==='user');const input=JSON.parse(message.content);
   const findings=input.results.map(item=>({stepId:item.stepId,passed:true,reason:'Reviewed',evidence:item.result}));
   return {status:200,body:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({evaluable:true,success:true,reason:'Reviewed all steps.',errorCount:0,findings})}]}]}};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const created=await post('/api/worker-sessions',{name:'Stale',profileId:'general',templateId:'chocolate-v2'}),id=created.body.id,url=`/api/worker-sessions/${id}/actions`;let revision=1,n=0;
  const command=(action,payload={})=>({requestId:`id-${++n}`,expectedRevision:revision++,action,payload});
  assert.equal((await post(url,command('start'))).status,200);
  for(let i=0;i<5;i++){assert.equal((await post(url,command('submit',{result:{type:'action',status:'completed'}}))).status,200);if(i<4)assert.equal((await post(url,command('next'))).status,200);}
  const evaluation=post(url,command('validate'));await arrived;
  // A concurrent valid navigation invalidates the exact captured revision.
  assert.equal((await post(url,{requestId:'concurrent-back',expectedRevision:revision-1,action:'back',payload:{}})).status,200);
  release();const result=await evaluation;assert.equal(result.status,409);assert.equal(result.body.code,'revision_conflict');assert.equal(providerCalls,1);
  const current=await (await fetch(`${base}/api/worker-sessions/${id}/status`)).json();assert.equal(current.evaluation,null);assert.equal(current.session.state,'in_progress');
  const template=await post('/api/worker-templates',{name:'Single task',description:'',rules:'PRIVATE-RULE',document:{schemaVersion:2,steps:[{id:'task',type:'action',prompt:'Inspect',evaluation:{kind:'acceptance_criteria',criteria:'PRIVATE-CRITERION'}}]}});assert.equal(template.status,201);
  const fresh=await post('/api/worker-sessions',{name:'Fresh',profileId:'general',templateId:template.body.id}),freshId=fresh.body.id,freshUrl=`/api/worker-sessions/${freshId}/actions`;
  for(const path of [`/api/worker-sessions/${freshId}`,`/api/worker-sessions/${freshId}/status`,'/api/worker-sessions']){const body=await (await fetch(base+path)).text();assert.equal(body.includes('PRIVATE-RULE'),false);assert.equal(body.includes('PRIVATE-CRITERION'),false);}
  assert.equal((await post(freshUrl,{requestId:'start',expectedRevision:1,action:'start',payload:{}})).status,200);
  assert.equal((await post(freshUrl,{requestId:'submit',expectedRevision:2,action:'submit',payload:{result:{type:'action',status:'completed'}}})).status,200);
  assert.equal((await post(freshUrl,{requestId:'validate',expectedRevision:3,action:'validate',payload:{}})).status,200);
  const freshStatus=await (await fetch(`${base}/api/worker-sessions/${freshId}/status`)).json();assert.equal(freshStatus.evaluation.success,true);assert.equal(providerCalls,2);
 }finally{release?.();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('concurrent duplicate evaluations commit one event',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'worker-v2-race-'));let server,release,entered;const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});let calls=0;
 try{
  server=createSessionServer(join(dir,'test.sqlite'),{workerEvaluator:async data=>{if(++calls===2)entered();await gate;return mockEvaluation(data);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const template=await post('/api/worker-templates',{name:'Race',description:'',rules:'Review.',document:{schemaVersion:2,steps:[{id:'task',type:'action',prompt:'Inspect',evaluation:{kind:'acceptance_criteria',criteria:'Confirm completion.'}}]}});
  const session=await post('/api/worker-sessions',{name:'Race',profileId:'general',templateId:template.body.id}),url=`/api/worker-sessions/${session.body.id}/actions`;
  await post(url,{requestId:'start',expectedRevision:1,action:'start',payload:{}});await post(url,{requestId:'submit',expectedRevision:2,action:'submit',payload:{result:{type:'action',status:'completed'}}});
  const command={requestId:'validate',expectedRevision:3,action:'validate',payload:{}},first=post(url,command),second=post(url,command);
  await arrived;release();const results=await Promise.all([first,second]);assert.deepEqual(results.map(value=>value.status),[200,200]);assert.equal(results.filter(value=>value.body.replayed).length,1);
  const events=await (await fetch(`${base}/api/worker-sessions/${session.body.id}/events`)).json();assert.equal(events.filter(item=>item.action==='evaluate').length,1);
  const competing=await post('/api/worker-sessions',{name:'Competing',profileId:'general',templateId:template.body.id}),competingUrl=`/api/worker-sessions/${competing.body.id}/actions`;
  const pair=await Promise.all([post(competingUrl,{requestId:'one',expectedRevision:1,action:'start',payload:{}}),post(competingUrl,{requestId:'two',expectedRevision:1,action:'start',payload:{}})]);
  assert.deepEqual(pair.map(value=>value.status).sort(),[200,409]);assert.equal(pair.find(value=>value.status===409).body.code,'revision_conflict');
 }finally{release?.();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('technical validation failure leaves state unchanged and permits retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'worker-v2-failure-'));let server,calls=0;
 try{
  server=createSessionServer(join(dir,'test.sqlite'),{workerEvaluator:async data=>++calls===1?{ok:false,error:'timeout'}:mockEvaluation(data)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const template=await post('/api/worker-templates',{name:'Failure',description:'',rules:'Review.',document:{schemaVersion:2,steps:[{id:'task',type:'action',prompt:'Inspect',evaluation:{kind:'acceptance_criteria',criteria:'Confirm completion.'}}]}});
  const created=await post('/api/worker-sessions',{name:'Failure',profileId:'general',templateId:template.body.id}),id=created.body.id,url=`/api/worker-sessions/${id}/actions`;
  await post(url,{requestId:'start',expectedRevision:1,action:'start',payload:{}});await post(url,{requestId:'submit',expectedRevision:2,action:'submit',payload:{result:{type:'action',status:'completed'}}});
  const command={requestId:'validate',expectedRevision:3,action:'validate',payload:{}};
  const failure=await post(url,command);assert.equal(failure.status,503);assert.equal(failure.body.code,'validation_unavailable');
  const before=await (await fetch(`${base}/api/worker-sessions/${id}/status`)).json();assert.equal(before.session.revision,3);assert.equal(before.evaluation,null);assert.ok(before.availableActions.includes('validate'));
  assert.equal((await post(url,command)).status,200);assert.equal(calls,2);
 }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('quiz review, private keys, single evaluation, immutable finish and fresh attempts survive reopening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'quiz-review-'));
 let server,base,calls=0;
 const boot=async()=>{
   server=createSessionServer(join(dir,'quiz.sqlite'),{workerEvaluator:async input=>{
     calls++;
     if(calls===1)return {ok:false,error:'timeout'};
     await new Promise(resolve=>setTimeout(resolve,20));
     return mockEvaluation(input);
   }});
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   base=`http://127.0.0.1:${server.address().port}/api`;
 };
 const stop=()=>new Promise(resolve=>server.close(resolve));
 const api=async(path,body)=>{
   const response=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
   return {status:response.status,data:await response.json()};
 };
 try{
   await boot();
   for(const path of ['/worker-templates','/worker-templates/quiz-v2']){
     assert.doesNotMatch(JSON.stringify((await api(path)).data),/correct_option|The correct answer is/);
   }
   const editor=(await api('/worker-templates/quiz-v2/editor')).data;
   assert.equal(editor.document.steps[0].evaluation.optionId,'option-1');
   const session=(await api('/worker-sessions',{name:'Quiz',profileId:'general',templateId:editor.id})).data;
   const path='/worker-sessions/'+session.id;
   let revision=1;
   const status=async()=>(await api(path+'/status')).data;
   const command=(action,payload={})=>({action,requestId:`r-${revision}-${action.replaceAll('_','-')}`,expectedRevision:revision,payload});
   const apply=async(action,payload={})=>{
     const response=await api(path+'/actions',command(action,payload));
     assert.equal(response.status,200,JSON.stringify(response.data));revision++;
   };
   const answer=optionId=>({result:{type:'question',optionId}});
   await apply('start');
   assert.ok(!(await status()).availableActions.includes('quiz_back'));
   assert.equal((await api(path+'/actions',command('quiz_next'))).status,409);
   await apply('submit',answer('option-2'));
   await apply('quiz_next');await apply('submit',answer('option-2'));
   await apply('quiz_back');await stop();await boot();
   let state=await status();
   assert.equal(state.results[0].result.optionId,'option-2');assert.equal(state.resolvedSteps,2);
   await apply('correct',answer('option-1'));await apply('quiz_next');
   assert.equal((await status()).results[1].result.optionId,'option-2');
   for(let i=2;i<5;i++){
     await apply('quiz_next');assert.ok(!(await status()).availableActions.includes('validate'));
     await apply('submit',answer(i===2?'option-3':'option-1'));
   }
   assert.equal(calls,0);
   assert.doesNotMatch(JSON.stringify(await status()),/correct_option|The correct answer is|quizReport/);
   const validate=command('validate');
   assert.equal((await api(path+'/actions',validate)).status,503);
   assert.equal((await status()).session.revision,revision);
   const both=await Promise.all([api(path+'/actions',validate),api(path+'/actions',validate)]);
   assert.deepEqual(both.map(result=>result.status),[200,200]);assert.equal(calls,2);revision++;
   const report=(await status()).quizReport;
   assert.deepEqual([report.total,report.correct,report.incorrect,report.percentage],[5,4,1,80]);
   assert.deepEqual([report.questions[4].selected,report.questions[4].correct],['POST','GET']);
   assert.equal((await api(path+'/actions',command('correct',answer('option-3')))).status,409);
   const again={requestId:'new-attempt',expectedRevision:revision};
   const fresh=await api(path+'/attempts',again);
   assert.equal(fresh.status,200);assert.notEqual(fresh.data.id,session.id);assert.equal(fresh.data.state,'in_progress');
   assert.equal((await api('/worker-sessions/'+fresh.data.id+'/status')).data.resolvedSteps,0);
   assert.equal((await api(path+'/attempts',again)).data.id,fresh.data.id);
   await apply('complete');await stop();await boot();
   state=await status();assert.equal(state.session.state,'completed');assert.deepEqual(state.quizReport,report);
   assert.equal((await api(path+'/attempts',again)).data.id,fresh.data.id);
   assert.equal((await api(path+'/actions',command('quiz_back'))).status,409);
 }finally{if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});

test('session name changes preserve active and final history; deletion cascades only to owned rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-management-'));
  const path = join(dir, 'management.sqlite');
  let server, base, release;
  const gate = new Promise(resolve => { release = resolve; });
  const boot = async () => {
    server = createSessionServer(path, {workerEvaluator: async prepared => {
      await gate;
      return mockEvaluation(prepared);
    }});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  const api = async (route, method = 'GET', body) => {
    const res = await fetch(base + route, {method, headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
    return {status: res.status, data: await res.json()};
  };
  try {
    await boot();
    const create = name => api('/worker-sessions', 'POST', {name, profileId:'general', templateId:'quiz-v2'});
    const {data:session} = await create('First');
    const {data:other} = await create('Other');
    const route = '/worker-sessions/' + session.id;
    const status = async () => (await api(route + '/status')).data;
    let revision = 1;
    const action = (action, payload = {}) => api(route+'/actions', 'POST', {
      action,payload,requestId:'command-'+revision,expectedRevision:revision++,
    });
    assert.equal((await action('start')).status,200);
    const original = (await api(route+'/events')).data;
    for (const invalid of [{name:'   '},{name:'a'.repeat(201)},{name:'X',revision:2}])
      assert.equal((await api(route,'PATCH',invalid)).status,400);
    assert.equal((await api(route,'PATCH',{name:'  Active quiz  '})).data.name,'Active quiz');
    assert.deepEqual((await api(route+'/events')).data,original);
    await stop(); await boot();
    assert.equal((await status()).session.name,'Active quiz');
    for(let i=0;i<5;i++){
      assert.equal((await action('submit',{result:{type:'question',optionId:'option-1'}})).status,200);
      if(i<4) assert.equal((await action('quiz_next')).status,200);
    }
    const validation = action('validate');
    let waiting;
    for(let i=0;i<40;i++){
      waiting=await status();
      if(waiting.validationPending)break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting.validationPending,true);
    assert.equal(waiting.evaluation,null);
    assert.equal(waiting.session.state,'in_progress');
    release();
    assert.equal((await validation).status,200);
    assert.equal((await action('complete')).status,200);
    const final=await status();
    assert.equal(final.validationPending,false);
    const history=(await api(route+'/events')).data;
    assert.equal((await api(route,'PATCH',{name:'Completed quiz'})).status,200);
    await stop();await boot();
    const restored=await status();
    assert.equal(restored.session.name,'Completed quiz');
    assert.equal(restored.session.revision,final.session.revision);
    assert.deepEqual(restored.quizReport,final.quizReport);
    assert.deepEqual((await api(route+'/events')).data,history);
    assert.equal((await api(route,'DELETE')).status,200);
    assert.equal((await api(route)).status,404);
    assert.equal((await api(route,'PATCH',{name:'Gone'})).status,404);
    assert.equal((await api(route,'DELETE')).status,404);
    assert.deepEqual((await api('/worker-sessions/'+other.id)).data,other);
    assert.equal((await api('/worker-templates/quiz-v2')).status,200);
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      for(const table of ['worker_events','worker_command_receipts'])
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(session.id).n,0);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally { db.close(); }
  } finally {
    release();
    if(server?.listening)await stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('Russian road quizzes keep their catalog, keys and ordered questions across retries and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'road-quizzes-'));
  const db = join(dir, 'sessions.sqlite');
  let server, base, evaluations = 0;
  const start = async () => {
    server = createSessionServer(db, {workerEvaluator: data => { evaluations++; return mockEvaluation(data); }});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  const api = async (route, body) => {
    const response = await fetch(base + route, body && {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
    });
    assert.ok(response.ok, route + ' returned ' + response.status);
    return response.json();
  };
  try {
    await start();
    const catalog = await api('/worker-templates');
    assert.deepEqual(await api('/worker-sessions'), []);
    for (const count of [5, 10]) {
      const name = `Правила дорожного движения — ${count} вопросов`;
      const matches = catalog.filter(t => t.name === name);
      assert.equal(matches.length, 1);
      const [template] = matches;
      const editor = await api('/worker-templates/' + template.id + '/editor');
      const session = await api('/worker-sessions', {name, profileId:'general', templateId:template.id});
      const path = '/worker-sessions/' + session.id;
      const command = (action, payload = {}) => api(path+'/actions', {
        action, payload, requestId:'cmd-'+revision, expectedRevision:revision++,
      });
      let revision = 1;
      const before = evaluations;
      await command('start');
      assert.equal(editor.document.steps.length, count);
      for (const [i, step] of editor.document.steps.entries()) {
        assert.match(step.prompt, /[А-Яа-яЁё]/u);
        assert.equal(step.type, 'question');
        assert.equal(step.options.length, 4);
        assert.equal(new Set(step.options.map(o => o.text)).size, 4);
        assert.ok(step.options.every(o => /[А-Яа-яЁё]/u.test(o.text)));
        assert.equal(step.options.filter(o => o.id === step.evaluation.optionId).length, 1);
        assert.equal(template.document.steps[i].evaluation, undefined);
        assert.ok(!(await api(path+'/status')).availableActions.includes('validate'));
        await command('submit', {result:{type:'question',optionId:step.evaluation.optionId}});
        if (i < count - 1) await command('quiz_next');
      }
      assert.equal(evaluations, before);
      await command('validate');
      assert.equal(evaluations, before+1);
      assert.equal((await api(path+'/status')).quizReport.correct, count);
      await command('complete');
      const retry = await api(path+'/attempts', {requestId:'retry', expectedRevision:revision});
      assert.deepEqual(retry.templateSnapshot, session.templateSnapshot);
      assert.deepEqual((await api('/worker-sessions/'+retry.id+'/status')).results, Array(count).fill(null));
    }
    const sessions = await api('/worker-sessions');
    await stop();
    await start();
    assert.deepEqual(await api('/worker-templates'), catalog);
    assert.deepEqual(await api('/worker-sessions'), sessions);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, {recursive:true, force:true});
  }
});
