import { transition } from '../src/worker-state-machine.ts';
import { transitionWorkerV2, workerV2EvaluationEvidence } from '../src/worker-state-machine-v2.ts';

const actionErrors = {
  invalid_input:[400,'Invalid action request.'], not_found:[404,'Worker session not found.'],
  invalid_transition:[409,'This action is not available.'], revision_conflict:[409,'The session changed; reload it.'],
  request_id_conflict:[409,'This request ID was already used.'], legacy_outcome_unavailable:[409,'The earlier outcome is unavailable.'],
  integrity_failure:[409,'The Worker history could not be verified.'], corrupt_events:[409,'The Worker history could not be verified.'], projection_mismatch:[409,'The Worker state could not be verified.'],
  validation_unavailable:[503,'Validation is unavailable.'], trusted_validation_unavailable:[503,'Validation is unavailable.'],
  storage_failure:[500,'The action could not be saved.'], unknown_outcome:[503,'The save outcome is unknown; retry with the same request ID.'],
};
function publicTemplate(template) {
  if (template?.document.schemaVersion !== 2) return template;
  return {
    ...template,
    rules: "",
    document: {
      ...template.document,
      steps: template.document.steps.map(({ evaluation, ...step }) => step),
    },
  };
}
const publicSession = (session) =>
  session && { ...session, templateSnapshot: publicTemplate(session.templateSnapshot) };

function quizReport(snapshot, state) {
  if (!state.evaluation || !snapshot.document.steps.every((step) => step.type === "question"))
    return null;
  const questions = snapshot.document.steps.map((step, index) => {
    const selectedId = state.results[index].result.optionId;
    const correctId = step.evaluation.optionId;
    return {
      stepId: step.id,
      prompt: step.prompt,
      selected: step.options.find((o) => o.id === selectedId).text,
      correct: step.options.find((o) => o.id === correctId).text,
      passed: selectedId === correctId,
    };
  });
  const correct = questions.filter((q) => q.passed).length;
  return {
    questions,
    total: questions.length,
    correct,
    incorrect: questions.length - correct,
    percentage: Math.round((100 * correct) / questions.length),
  };
}

const v2Context=(id,snapshot)=>({workflowVersion:2,sessionId:id,...(snapshot.document.allowBack===undefined?{}:{allowBack:snapshot.document.allowBack}),steps:snapshot.document.steps.map(step=>step.type==='question'?{id:step.id,type:step.type,prompt:step.prompt,options:step.options}:{id:step.id,type:step.type,prompt:step.prompt})});
export function createWorkerRoutes(repository, transitions, evaluateWorker) {
  const evaluating = new Map();
  async function evaluateOnce(prepared) {
    const {state,revision,snapshot}=prepared;
    if (!snapshot.document.steps.every(step=>step.type==='question')) return evaluateWorker(prepared);
    const key=JSON.stringify([state.sessionId,revision]);
    if (!evaluating.has(key)) {
      const work=Promise.resolve().then(()=>evaluateWorker(prepared)).then(result=>{
        // A structured model response can still contradict the immutable key.
        if (result?.ok && !snapshot.document.steps.every((step,i)=>
          result.evaluation?.findings?.[i]?.passed === (state.results[i].result.optionId === step.evaluation.optionId)))
          return {ok:false,error:'invalid_response'};
        return result;
      }).finally(()=>evaluating.delete(key));
      evaluating.set(key,work);
    }
    return evaluating.get(key);
  }
  return async (req, path, reply) => {
    if(/^\/api\/worker-sessions\/[^/]+\/actions$/.test(path) && !/^\/api\/worker-sessions\/[a-zA-Z0-9-]{1,100}\/actions$/.test(path)) {reply(400,{code:'invalid_input',message:'Invalid session ID.'});return true;}
    const match = path.match(
      /^\/api\/(worker-templates|worker-sessions)(?:\/([a-zA-Z0-9-]+))?(?:\/(events|actions|status|editor|attempts))?$/,
    );
    if (!match) return false;
    const [, kind, id, resource] = match,
      templates = kind === "worker-templates";
    if(resource==='editor'){
      if (!templates || !id || req.method!=='GET'){reply(405,{error:'Method not allowed.'});return true;}
      const template=repository.getTemplate(id);
      reply(template?200:404,template ?? {error:'Template not found.'});return true;
    }
    if(resource==='attempts'){
      if (templates || !id || req.method!=='POST'){reply(405,{error:'Method not allowed.'});return true;}
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096){reply(413,{code:'invalid_input'});return true;}}
      let body;try{body=JSON.parse(raw);}catch{}
      if(!body || typeof body!=='object' || Object.keys(body).length!==2 || !Object.hasOwn(body,'requestId') || !Object.hasOwn(body,'expectedRevision')){
        reply(400,{code:'invalid_input'});return true;
      }
      const attempt=transitions.retryQuiz(id,body.requestId,body.expectedRevision);
      if(!attempt.ok){const [status,message]=actionErrors[attempt.error] ?? actionErrors.storage_failure;reply(status,{code:attempt.error,message});return true;}
      reply(200,publicSession(repository.getSession(attempt.id)));return true;
    }
    if(resource==='status' && !templates && id) {
      if(req.method!=='GET'){reply(405,{code:'method_not_allowed',message:'Method not allowed.'});return true;}
      const checked=transitions.load(id);
      if(!checked.ok){const [status,message]=actionErrors[checked.error] ?? [500,'The Worker state could not be loaded.'];reply(status,{code:actionErrors[checked.error]?checked.error:'storage_failure',message});return true;}
      const session=repository.getSession(id);
      if(!session || session.revision!==checked.data.revision){reply(409,{code:'revision_conflict',message:'The session changed; reload it.'});return true;}
      if(checked.data.state.workflowVersion===2){
        const state=checked.data.state,context=v2Context(id,session.templateSnapshot),step=context.steps[state.stepIndex];
        const quiz=context.steps.every(step=>step.type==='question');
        const simple=(quiz && state.evaluation?['complete']:['start','next','back','retry','complete',...(quiz?['quiz_next','quiz_back']:[])]).filter(type=>transitionWorkerV2(state,{type},context).ok);
        const sample=step.type==='question'?{type:'question',optionId:step.options[0].id}:{type:'action',status:'completed'};
        for(const type of ['submit','correct'])if(!(quiz && state.evaluation) && transitionWorkerV2(state,{type,stepId:step.id,visit:state.visit,result:sample},context).ok)simple.push(type);
        if(workerV2EvaluationEvidence(state,context).ok)simple.push('validate');
        reply(200,{session:publicSession(session),validationPending:quiz && evaluating.has(JSON.stringify([id,session.revision])),availableActions:simple,resolvedSteps:state.results.filter(Boolean).length,totalSteps:context.steps.length,completion:state.completion,results:state.results,submissions:state.submissions,evaluation:state.evaluation,...(quiz && state.evaluation?{quizReport:quizReport(session.templateSnapshot,state)}:{})});return true;
      }
      const state=checked.data.state, context={steps:session.templateSnapshot.document.steps};
      const availableActions=['start','next','back','retry','continue','complete'].filter(type=>transition(state,{type},context).ok);
      reply(200,{session,availableActions,resolvedSteps:state.resolutions.filter(value=>value!==null).length,totalSteps:context.steps.length,completion:state.completion});return true;
    }
    if(resource==='actions' && !templates && id) {
      if(req.method!=='POST'){reply(405,{code:'method_not_allowed',message:'Method not allowed.'});return true;}
      const v2=transitions.isV2?.(id)===true;
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>(v2?16000:4096)){reply(413,{code:'invalid_input',message:'Request too large.'});return true;}}
      let value;try{value=JSON.parse(body);}catch{reply(400,{code:'invalid_input',message:'Invalid JSON.'});return true;}
      const keys=value && typeof value==='object' && !Array.isArray(value) ? Object.keys(value) : [];
      const validId=value=>typeof value==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
      if(keys.length!==4 || keys.some(key=>!['requestId','expectedRevision','action','payload'].includes(key)) || !validId(id) || !validId(value.requestId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision<1 || !(v2?['start','next','back','quiz_next','quiz_back','retry','complete','submit','correct','validate']:['start','next','back','retry','continue','complete']).includes(value.action) || !value.payload || typeof value.payload!=='object' || Array.isArray(value.payload) || (['submit','correct'].includes(value.action)?Object.keys(value.payload).length!==1||!Object.hasOwn(value.payload,'result'):Object.keys(value.payload).length!==0)){reply(400,{code:'invalid_input',message:'Invalid action request.'});return true;}
      const request={sessionId:id,requestId:value.requestId,expectedRevision:value.expectedRevision,action:['submit','correct'].includes(value.action)?{type:value.action,result:value.payload.result}:{type:value.action==='validate'?'evaluate':value.action}};
      let result;
      if(v2 && value.action==='validate'){
        const prepared=transitions.prepareV2Evaluation(request);
        if(!prepared.ok || !prepared.prepared)result=prepared;
        else if(typeof evaluateWorker!=='function')result={ok:false,error:'validation_unavailable'};
        else {
          let evaluated;try{evaluated=await evaluateOnce(prepared.data);}catch{evaluated={ok:false};}
          result=evaluated?.ok?transitions.commitV2Evaluation(request,{schemaVersion:1,sessionId:id,sourceRevision:prepared.data.revision,evidence:prepared.data.binding.evidence,...evaluated.evaluation}):{ok:false,error:evaluated?.error==='stale_context'?'revision_conflict':'validation_unavailable'};
        }
      }else result=transitions.apply(request);
      if(!result.ok){const [status,message]=actionErrors[result.error] ?? [500,'The action could not be saved.'];reply(status,{code:actionErrors[result.error]?result.error:'storage_failure',message,requestId:value.requestId,replayed:result.replayed===true,historical:result.historical===true});return true;}
      const {state,revision}=result.data;
      reply(200,{status:'applied',requestId:value.requestId,replayed:result.replayed===true,historical:result.historical===true,event:{action:value.action,resultingRevision:revision},result:{state:state.status,stepIndex:state.stepIndex,attempt:state.attempt,visit:state.visit,completion:state.completion,revision}});return true;
    }
    if (resource && (templates || !id || req.method !== "GET")) {
      reply(405, { error: "Method not allowed." });
      return true;
    }
    if (req.method === "GET") {
      if (resource) {
        if (!repository.getSession(id))
          reply(404, { error: "Session not found." });
        else reply(200, repository.events(id));
      } else if (id) {
        const value = templates
          ? repository.getTemplate(id)
          : repository.getSession(id);
        reply(value ? 200 : 404, templates ? publicTemplate(value) ?? { error: "Resource not found." } : publicSession(value) ?? { error: "Resource not found." });
      } else
        reply(
          200,
          templates ? repository.listTemplates().map(publicTemplate) : repository.listSessions().map(publicSession),
        );
      return true;
    }
    if (id && !resource && req.method === "DELETE") {
      const result = templates ? repository.deleteTemplate(id) : repository.deleteSession(id);
      reply(
        result.value ? 200 : 404,
        result.value ? { id, deleted: true } : { error: "Resource not found." },
      );
      return true;
    }
    if (
      (req.method === "POST" && !id && !resource) ||
      (req.method === "PATCH" && id && !resource)
    ) {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 200000) {
          reply(413, { error: "Request too large." });
          return true;
        }
      }
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        reply(400, { error: "Invalid JSON." });
        return true;
      }
      const result = templates
        ? id
          ? repository.updateTemplate(id, value)
          : repository.createTemplate(value)
        : id ? repository.renameSession(id, value) : repository.createSession(value);
      if (result.error) {
        reply(
          result.error === "invalid"
            ? 400
            : result.error === "missing"
              ? 404
              : 409,
          { error: result.error },
        );
        return true;
      }
      reply(id ? 200 : 201, templates ? result.value : publicSession(result.value));
      return true;
    }
    reply(405, { error: "Method not allowed." });
    return true;
  };
}
