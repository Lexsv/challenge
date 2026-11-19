import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const providers = new Set(['openai', 'opencode-console', 'opencode-go']);

/** Local Docker volume storage. Keys are plaintext and protected by filesystem permissions. */
export class FileCredentialStore {
  constructor(directory) { this.directory = directory; }
  async path(provider) {
    if (!providers.has(provider)) throw new Error('Unsupported provider.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    return join(this.directory, provider);
  }
  async status(provider) {
    try { const handle = await open(await this.path(provider), constants.O_RDONLY | constants.O_NOFOLLOW); await handle.close(); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async save(provider, key) {
    if (typeof key !== 'string' || !key) throw new Error('Invalid credential.');
    const path = await this.path(provider), temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(key, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, path);
    } catch (error) { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }
  async read(provider) {
    const handle = await open(await this.path(provider), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }
  async forget(provider) { try { await unlink(await this.path(provider)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
