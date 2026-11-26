export interface CredentialStore {
  status(provider: string): Promise<boolean>;
  save(provider: string, key: string): Promise<void>;
  forget(provider: string): Promise<void>;
  read(provider: string): Promise<string>;
}
export class MacKeychainStore implements CredentialStore {
  status(provider: string): Promise<boolean>;
  save(provider: string, key: string): Promise<void>;
  forget(provider: string): Promise<void>;
  read(provider: string): Promise<string>;
}
export function createSavedProviderTransport(
  store?: CredentialStore,
  fetcher?: typeof fetch,
  waitForPending?: (provider:string)=>Promise<void>,
  clock?: typeof import("../src/server-time-context.ts").serverClock,
): (provider:string, request:Record<string,unknown>, isCurrent?:()=>boolean)=>Promise<{status:number;body:unknown}>;
