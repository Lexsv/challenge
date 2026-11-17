export function createSessionServer(databasePath?: string, options?: {
  credentialStore?: import('./credentials.mjs').CredentialStore;
  fetcher?: typeof fetch;
  topicProcess?: (repository:import('../src/topic-lifecycle').TopicSegmentRepository,sessionId:string,runId:string)=>Promise<void>;
  mockModel?: boolean;
}): import('node:http').Server;
