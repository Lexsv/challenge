export function createSessionServer(databasePath?: string, options?: {
  credentialStore?: import('./credentials.mjs').CredentialStore;
  fetcher?: typeof fetch;
}): import('node:http').Server;
