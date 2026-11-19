import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  demoWorkers,
  workerSteps,
  WorkerSessionPreview,
  WorkerControls,
  WorkerLifecycleMessage,
  WorkerResultControls,
  AnswerOptions,
  QuizQuestionCard,
  WorkerTemplates,
} from "./worker-ui";
import { SessionTypeFields } from "./new-session-dialog";
import {
  createWorkerSession,
  getWorkerSession,
  sendWorkerAction,
  WorkerActionError,
  saveWorker,
  workerDocument,
  workerFromRecord,
} from "./worker-api";

describe("Worker preview", () => {
  it("provides two five-step templates and shows them in management", () => {
    expect(demoWorkers.map((worker) => worker.name)).toEqual([
      "Programming Quiz",
      "Chocolate Production",
    ]);
    expect(demoWorkers.map((worker) => workerSteps(worker).length)).toEqual([
      5, 5,
    ]);
    const html = renderToStaticMarkup(
      <WorkerTemplates workers={demoWorkers} onChange={() => {}} />,
    );
    expect(html).toContain("New Worker");
    expect(html).toContain("Edit Programming Quiz");
    expect(html).toContain("Actions for Chocolate Production");
    expect(html).not.toContain("reset on reload");
  });
  it("renders a pre-start screen without workflow actions", () => {
    const html = renderToStaticMarkup(
      <WorkerSessionPreview session={{ id: 's', name: 'Chocolate demo', profileId: 'p', templateId: 't', templateVersion: 1, templateSnapshot: { ...demoWorkers[1], version: 1, document: workerDocument(demoWorkers[1].steps) }, state: 'not_started', stepIndex: 0, attempt: 1, revision: 1 }} />,
    );
    expect(html).toContain("Chocolate demo");
    expect(html).toContain("Walk through five chocolate production steps.");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Start");
    expect(html).not.toContain("Failure");
    expect(html).not.toContain("Validate");
  });
  it("keeps Chat as the default session type", () => {
    const html = renderToStaticMarkup(
      <SessionTypeFields
        sessionType="chat"
        workerId=""
        workers={demoWorkers}
        onTypeChange={() => {}}
        onWorkerChange={() => {}}
      />,
    );
    expect(html).toContain("Session Type");
    expect(html).toContain("Chat");
    expect(html).not.toContain("Worker Template");
    const worker = renderToStaticMarkup(
      <SessionTypeFields
        sessionType="worker"
        workerId="quiz"
        workers={demoWorkers}
        onTypeChange={() => {}}
        onWorkerChange={() => {}}
      />,
    );
    expect(worker).toContain("Worker Template");
    expect(worker).toContain("Programming Quiz");
  });
  it("converts the visual editor to structured questions and rejects incomplete choices", () => {
    const document = workerDocument(
      "Which language? A) Rust B) Java\nCompile the project",
    );
    expect(document.steps[0].type).toBe("question");
    expect(document.steps[1].type).toBe("action");
    expect(() => workerDocument("Question? A) Only one")).toThrow();
    expect(
      workerFromRecord({
        id: "x",
        name: "X",
        description: "",
        rules: "",
        version: 1,
        document,
      }).steps,
    ).toContain("A) Rust B) Java");
  });
  it("sends the selected profile and template to create a durable session", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ id: "session-1", state: "not_started" }),
      });
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await createWorkerSession("Quiz", "general", "quiz");
      expect(result.state).toBe("not_started");
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        name: "Quiz",
        profileId: "general",
        templateId: "quiz",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("sends the expected version and reports a conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409 }),
    );
    try {
      await expect(
        saveWorker({ ...demoWorkers[0], version: 1 }),
      ).rejects.toThrow("changed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("preserves structured step IDs, types and multiline text on metadata edits", async () => {
    const document = {
      schemaVersion: 1 as const,
      steps: [
        {
          id: "original-action",
          type: "action" as const,
          prompt: "Compare A) literal B) labels\nThen continue",
        },
      ],
    };
    const record = {
      id: "t",
      name: "Before",
      description: "",
      rules: "",
      version: 4,
      document,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ...record, name: "After", version: 5 }),
      });
    vi.stubGlobal("fetch", fetcher);
    try {
      await saveWorker({ ...workerFromRecord(record), name: "After" });
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
        document,
        expectedVersion: 4,
        name: "After",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('saves V2 criteria and correct option IDs without silently dropping them', async () => {
    const document={schemaVersion:2 as const,steps:[{id:'q',type:'question' as const,prompt:'Which?',options:[{id:'a',text:'Java'},{id:'b',text:'Rust'}],evaluation:{kind:'correct_option' as const,optionId:'b',criteria:'Rust is correct.'}}]};
    const record={id:'v2',name:'Quiz',description:'',rules:'Review.',version:1,document};
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({...record,version:2})});vi.stubGlobal('fetch',fetcher);
    try {await saveWorker(workerFromRecord(record));expect(JSON.parse(fetcher.mock.calls[0][1].body).document).toEqual(document);}
    finally {vi.unstubAllGlobals();}
  });
  it('edits a quiz key using its option label and saves only a valid option reference', async () => {
    const record = {id:'quiz',name:'Quiz',description:'',rules:'Review.',version:1,document:{
      schemaVersion:2 as const, steps:[{id:'q',type:'question' as const,prompt:'Choose a language',
        options:[{id:'first',text:'Java'},{id:'second',text:'Rust'}],
        evaluation:{kind:'correct_option' as const,optionId:'second',criteria:'The correct answer is Rust.'}}]}};
    const quiz=workerFromRecord(record);
    const html=renderToStaticMarkup(<WorkerTemplates workers={[quiz]} onChange={()=>{}}/>);
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('Correct answers');
    expect(html).toContain('Rust');
    expect(html).not.toMatch(/Workflow version|Answer keys/);
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>record});
    vi.stubGlobal('fetch',fetcher);
    try {
      await expect(saveWorker({...quiz,correctOptionIds:['absent']})).rejects.toThrow('Select the correct answer');
      expect(fetcher).not.toHaveBeenCalled();
      await saveWorker({...quiz,correctOptionIds:['first']});
      expect(JSON.parse(fetcher.mock.calls[0][1].body).document.steps[0].evaluation).toEqual({
        kind:'correct_option',optionId:'first',criteria:'The correct answer is Java.'
      });
    } finally {vi.unstubAllGlobals();}
  });
  it("does not report success when template creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unavailable")),
    );
    try {
      await expect(saveWorker(demoWorkers[0])).rejects.toThrow(
        "Network unavailable",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe("Worker action API", () => {
  const command = { requestId: "request-1", expectedRevision: 4, action: "start" as const, payload: {} };
  it("sends the same command and preserves replay and historical markers", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "applied", requestId: "request-1", replayed: true, historical: true, result: { state: "in_progress", stepIndex: 0, attempt: 1, revision: 5 } }) });
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await sendWorkerAction("session-1", command)).toMatchObject({ replayed: true, historical: true });
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command);
      expect(fetcher.mock.calls[0][0]).toBe("/api/worker-sessions/session-1/actions");
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["revision_conflict", "invalid_transition", "request_id_conflict", "integrity_failure", "unknown_outcome"])("preserves %s for reconciliation", async code => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code }) }));
    try { await expect(sendWorkerAction("s", command)).rejects.toMatchObject({ code }); }
    finally { vi.unstubAllGlobals(); }
  });
  it("propagates network interruptions and reads the session endpoint", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s", revision: 3 }) });
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(sendWorkerAction("s", command)).rejects.toThrow("offline");
      expect(await getWorkerSession("s")).toMatchObject({ id: "s", revision: 3 });
      expect(fetcher.mock.calls[1][0]).toBe("/api/worker-sessions/s");
      expect(new WorkerActionError("unknown_outcome", "x").code).toBe("unknown_outcome");
    } finally { vi.unstubAllGlobals(); }
  });
  it("renders persisted active state and immutable snapshot content", () => {
    const document = workerDocument("Original task\nOther task");
    const html = renderToStaticMarkup(<WorkerSessionPreview session={{ id: "s", name: "Session", profileId: "owner", templateId: "t", templateVersion: 1, templateSnapshot: { id: "t", name: "Snapshot", description: "Stored", rules: "", version: 1, document }, state: "in_progress", stepIndex: 1, attempt: 1, revision: 7 }} />);
    expect(html).toContain("Other task");
    expect(html).toContain("Step 2 of 2");
    expect(html).toContain("Active");
    expect(html).not.toContain(">Start</button>");
  });
});


describe('Server-driven Worker controls', () => {
  it.each([
    { actions: [] as const, shown: [], hidden: ['Next', 'Complete'] },
    { actions: ['next'] as const, shown: ['Next'], hidden: ['Back', 'Complete'] },
    { actions: ['back', 'next'] as const, shown: ['Back', 'Next'], hidden: ['Complete'] },
    { actions: ['back', 'complete'] as const, shown: ['Back', 'Complete'], hidden: ['Next'] },
    { actions: ['retry', 'continue'] as const, shown: ['Retry', 'Continue'], hidden: ['Next'] },
  ])('shows only allowed controls for $actions', ({ actions, shown, hidden }) => {
    const html = renderToStaticMarkup(<WorkerControls available={[...actions]} disabled={false} pending={null} onAction={() => {}} />);
    for (const label of shown) expect(html).toContain(`>${label}</button>`);
    for (const label of hidden) expect(html).not.toContain(`>${label}</button>`);
  });
  it('disables competing actions and retains a pending command for reconciliation', () => {
    const html = renderToStaticMarkup(<WorkerControls available={['back', 'next']} disabled={false} pending={{requestId:'r',expectedRevision:3,action:'next',payload:{}}} onAction={() => {}} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Reconcile Next');
  });
  it('disables actions while a request is pending', () => {
    const html = renderToStaticMarkup(<WorkerControls available={['next']} disabled pending={null} onAction={() => {}} />);
    expect(html).toContain('disabled=""');
  });
  it('offers Retry Validate after a technical validation failure', () => {
    const html=renderToStaticMarkup(<WorkerControls available={['validate']} disabled={false} pending={null} retryValidation onAction={() => {}} />);
    expect(html).toContain('Retry Validate');
  });
  it.each(['next','back','retry','continue','complete'] as const)('sends %s with its stable request and revision', async action => {
    const command = {requestId:'stable-id',expectedRevision:8,action,payload:{}};
    const fetcher = vi.fn().mockResolvedValue({ok:true,json:async()=>({status:'applied',requestId:'stable-id',historical:false,replayed:false})});
    vi.stubGlobal('fetch',fetcher);
    try { await sendWorkerAction('session',command); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command); }
    finally { vi.unstubAllGlobals(); }
  });
  it.each(['submit','correct'] as const)('sends a %s result without an evaluation verdict',async action=>{
    const command={requestId:'stable-id',expectedRevision:8,action,payload:{result:{type:'question',optionId:'option-2'}}};
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({status:'applied',requestId:'stable-id',historical:false,replayed:false})});
    vi.stubGlobal('fetch',fetcher);
    try{await sendWorkerAction('session',command);expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command);}
    finally{vi.unstubAllGlobals();}
  });
});

describe('V2 result control interactions',()=>{
  type Clickable={children?:React.ReactNode;onClick?:()=>void;disabled?:boolean};
  const controls=(node:React.ReactNode):Clickable[]=>{
    if(Array.isArray(node))return node.flatMap(controls);
    if (React.isValidElement<React.ComponentProps<typeof AnswerOptions>>(node) && node.type === AnswerOptions) return controls(AnswerOptions(node.props));
    if(!React.isValidElement<Clickable>(node))return [];
    return [...(node.props.onClick?[node.props]:[]),...controls(node.props.children)];
  };
  it('submits and corrects the selected option using only result data',()=>{
    const onAction=vi.fn(),step={id:'q',type:'question' as const,prompt:'Which?',options:[{id:'a',text:'A'},{id:'b',text:'B'}]};
    for(const action of ['submit','correct'] as const){
      const tree=WorkerResultControls({step,available:[action],disabled:false,selectedOption:'b',reporting:false,onReporting:()=>{},problem:'',onSelectedOption:()=>{},onProblem:()=>{},onAction});
      const button=controls(tree).at(-1)!;expect(button.disabled).toBe(false);button.onClick?.();
      expect(onAction).toHaveBeenLastCalledWith(action,{result:{type:'question',optionId:'b'}});
    }
  });
  it('renders lettered options and highlights the saved answer until a new selection is made',()=>{
    const step={id:'q',type:'question' as const,prompt:'Which?',options:[{id:'a',text:'First'},{id:'b',text:'Second'}]};
    const props={step,available:['correct' as const],disabled:false,selectedOption:'',savedOption:'b',problem:'',reporting:false,onReporting:()=>{},onSelectedOption:vi.fn(),onProblem:()=>{},onAction:vi.fn()};
    const initial=WorkerResultControls(props);
    expect(controls(initial).map(button=>button.disabled)).toEqual([false,false,true]);
    expect(renderToStaticMarkup(initial)).toContain('aria-pressed="true"');
    controls(initial)[0].onClick?.();
    expect(props.onSelectedOption).toHaveBeenCalledWith('a');
    expect(props.onAction).not.toHaveBeenCalled();
    expect(controls(WorkerResultControls({...props,selectedOption:'a'})).at(-1)?.disabled).toBe(false);
  });
  it('saves options directly and enables only authorized in-card navigation', () => {
    const step = {id:'q', type:'question' as const, prompt:'Which?',options:[{id:'a',text:'First'},{id:'b',text:'Second'}]};
    const onAction = vi.fn();
    const props = {step, first:true, last:false, disabled:false, onAction, validationFailed:false};
    const buttons = controls(QuizQuestionCard({...props,available:['submit']}));
    expect(buttons.map(b=>b.disabled)).toEqual([false,false,true,true]);
    buttons[1].onClick?.();
    expect(onAction.mock.calls).toEqual([['submit',{result:{type:'question',optionId:'b'}}]]);
    const saved = controls(QuizQuestionCard({...props,first:false,last:true,value:'b',available:['correct','quiz_back','validate']}));
    expect(saved.map(b=>b.disabled)).toEqual([false,false,false,false]);
    saved[0].onClick?.();saved[2].onClick?.();saved[3].onClick?.();
    expect(onAction.mock.calls.slice(1)).toEqual([['correct',{result:{type:'question',optionId:'a'}}],['quiz_back'],['validate']]);
    const last = QuizQuestionCard({...props,last:true,available:['submit']});
    expect(controls(last).at(-1)?.disabled).toBe(true);
    expect(renderToStaticMarkup(last)).toContain('Validate');
  });
  it('shows an indeterminate validation indicator inside the locked final question', () => {
    const step={id:'q',type:'question' as const,prompt:'Choose',options:[{id:'a',text:'First'},{id:'b',text:'Second'}]};
    const props={step,first:false,last:true,disabled:true,onAction:vi.fn(),available:['validate' as const],validationFailed:false};
    const tree=QuizQuestionCard({...props,validating:true});
    const html=renderToStaticMarkup(tree);
    expect(html).toContain('Validating…');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('aria-valuenow');
    expect(controls(tree).every(button=>button.disabled)).toBe(true);
    const saving=renderToStaticMarkup(QuizQuestionCard({...props,last:false}));
    expect(saving).not.toMatch(/Validating…|in progress…|role="progressbar"/);
  });
  it('reports problems and disables submissions while pending',()=>{
    const onAction=vi.fn(),step={id:'task',type:'action' as const,prompt:'Inspect'};
    const onReporting=vi.fn();
    const props={step,available:['submit' as const],selectedOption:'',problem:'Damaged',reporting:false,onReporting,onSelectedOption:()=>{},onProblem:()=>{},onAction};
    const initial=WorkerResultControls({...props,disabled:false});
    expect(renderToStaticMarkup(initial)).not.toContain('Problem description');
    const buttons=controls(initial);
    buttons[0].onClick?.();buttons[1].onClick?.();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('submit',{result:{type:'action',status:'completed'}});
    expect(onReporting).toHaveBeenCalledWith(true);
    const form=controls(WorkerResultControls({...props,reporting:true,disabled:false}));
    form[0].onClick?.();form[1].onClick?.();
    expect(onAction).toHaveBeenLastCalledWith('submit',{result:{type:'action',status:'problem',reason:'Damaged'}});
    expect(onReporting).toHaveBeenLastCalledWith(false);
    expect(controls(WorkerResultControls({...props,reporting:true,problem:'  ',disabled:false}))[0].disabled).toBe(true);
    expect(controls(WorkerResultControls({...props,reporting:true,disabled:true})).every(button=>button.disabled)).toBe(true);
  });
});

describe('Failed Worker recovery messaging', () => {
  const render = (available: ('retry' | 'back')[], loaded = true, loading = false, pending: null | {requestId: string; expectedRevision: number; action: 'retry'; payload: Record<string, never>} = null) => renderToStaticMarkup(<>
    <WorkerLifecycleMessage state="failed" available={available} loaded={loaded} loading={loading} pending={pending} />
    <WorkerControls available={available} disabled={loading || !loaded} pending={pending} onAction={() => {}} />
  </>);
  it('offers recovery when the server permits Retry', () => {
    const html = render(['retry']);
    expect(html).toContain('You can retry the failed operation.');
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('unavailable');
  });
  it('explains that recovery is unavailable when Retry is not permitted', () => {
    const html = render([]);
    expect(html).toContain('Recovery is currently unavailable.');
    expect(html).not.toContain('>Retry</button>');
  });
  it('shows a pending Retry without enabling duplicate actions', () => {
    const html = render(['retry'], true, true, {requestId:'r',expectedRevision:3,action:'retry',payload:{}});
    expect(html).toContain('Retrying the failed operation');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it('keeps Retry pending while a reactivated view refreshes its status', () => {
    const html = render(['retry'], false, true, {requestId:'r',expectedRevision:3,action:'retry',payload:{}});
    expect(html).toContain('Retrying the failed operation');
    expect(html).not.toContain('You can retry');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it('waits for authoritative availability during restoration', () => {
    const html = render(['retry'], false, true);
    expect(html).toContain('Checking recovery availability');
    expect(html).not.toContain('You can retry');
    expect(html).not.toContain('Recovery is currently unavailable');
    expect(html).toContain('disabled=""');
  });
  it('renders in-progress status after the refreshed server state recovers', () => {
    const html = renderToStaticMarkup(<WorkerLifecycleMessage state="in_progress" available={[]} loaded loading={false} pending={null} />);
    expect(html).toContain('In progress');
    expect(html).not.toContain('failed');
  });
});
