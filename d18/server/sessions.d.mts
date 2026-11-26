type Schedule = {kind:'once'; at:number} | {kind:'interval'; startAt:number; everyMs:number};
type ToolPermission = {connectionId:string; toolId:string};
type TaskDefinition = {
  name?:string; instructions:string; provider:'openai'|'opencode-console'|'opencode-go';
  model:string; schedule:Schedule; timezone:string; enabled:boolean; permissions?:ToolPermission[];
};
type SavedTask = Omit<TaskDefinition,'permissions'> & {
  name:string; stopped:boolean; next_due_at:number|null;
  id:string; permissions:ToolPermission[]; revision:number; created_at:number; updated_at:number;
};
type Occurrence = {
  id:string; task_id:string; task_revision:number; due_at:number; created_at:number;
  started_at:number|null; rejected_at:number|null; rejection:string|null; finished_at:number|null;
  state:keyof typeof import('../src/execution-policy').runTransitions;
  result:{answer:string; response:string|null}|null; error:string|null;
};

export function createSessionServer(databasePath?: string, options?: {
  schedulerOptions?: {pollMs?:number};
  credentialStore?: import('./credentials.mjs').CredentialStore;
  fetcher?: typeof fetch;
  topicProcess?: (repository:import('../src/topic-lifecycle').TopicSegmentRepository,sessionId:string,runId:string)=>Promise<void>;
  mockModel?: boolean;
  instructionDetector?: {providerId:string;model:string};
  instructionDetectorEnabled?: ()=>boolean;
  instructionDetectorTransport?: (provider:string,body:Record<string,unknown>)=>Promise<{status:number;body:unknown}>;
  instructionDetectorMeter?: (value:{sessionId:string;runId:string;meter:import('../src/token-meter').RequestMeter})=>Promise<void>;
  turnContextOptions?: {now?:()=>number;ttlMs?:number;maxEntries?:number};
  instructionProposalOptions?: {now?:()=>number;ttlMs?:number;maxEntries?:number};
}): import('node:http').Server & {
  stopExecutions():Promise<void>;
  scheduledTasks:{
    createTask(definition:TaskDefinition):SavedTask;
    getTask(id:string):SavedTask;
    configure(id:string, expectedRevision:number, changes:{enabled?:boolean; permissions?:ToolPermission[]}):SavedTask;
    materialize(taskId:string, dueAt:number):string;
    start(id:string):SavedTask;
    pause(id:string):SavedTask;
    resume(id:string):SavedTask;
    stop(id:string):SavedTask;
    getOccurrence(id:string):Occurrence;
    executeOccurrence(id:string):Promise<Occurrence>;
  };
  executeWeek4Turn(sessionId:string, command:{
    turnId:string; provider:'openai'|'opencode-console'|'opencode-go'; model:string; question:string;
  }):Promise<{status:'completed'; redacted:boolean; maintenanceFailed?:boolean; instructionOutcome?:import('../src/week3-session-api').InstructionTurnOutcome}>;
};
