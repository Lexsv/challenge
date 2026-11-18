export function createSessionServer(databasePath?: string, options?: {
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
}): import('node:http').Server;
