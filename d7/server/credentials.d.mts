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
