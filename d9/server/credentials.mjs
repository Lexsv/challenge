import { providerError } from './provider-error.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const endpoints = Object.freeze({
  openai: 'https://api.openai.com/v1/responses',
  'opencode-console': 'https://opencode.ai/inference/openai/v1/chat/completions',
  'opencode-go': 'https://opencode.ai/inference/go/openai/v1/chat/completions',
});

// No Keychain operation runs at import or server startup. All queries use this app's exact service/account.
export class MacKeychainStore {
  async operation(action, provider, key) {
    if (process.platform !== 'darwin') throw new Error('macOS Keychain unavailable.');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/swift', [fileURLToPath(new URL('./keychain.swift', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Keychain operation failed.')); }, 30000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 65536) child.kill(); });
      child.stderr.on('data', () => {}); // Compiler/OS errors are never returned or logged.
      child.on('error', () => { clearTimeout(timer); reject(new Error('Keychain operation failed.')); });
      child.on('close', (code) => {
        clearTimeout(timer);
        try { const result = JSON.parse(output); if (code !== 0 || !result.ok) throw new Error(); resolve(result); }
        catch { reject(new Error('Keychain operation failed.')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ action, provider, ...(key === undefined ? {} : { key }) }));
    });
  }
  async status(provider) { return (await this.operation('status', provider)).saved; }
  async save(provider, key) { await this.operation('save', provider, key); }
  async forget(provider) { await this.operation('forget', provider); }
  async read(provider) { return (await this.operation('read', provider)).key; }
}

export function createCredentialRoutes(store = new MacKeychainStore(), fetcher = fetch) {
  const statuses = new Map();
  const generations = new Map();
  const queues = new Map();
  const clientRevisions = new Map();
  const acceptClientRevision = (provider, client, revision) => {
    if (client === undefined && revision === undefined) return true;
    const number = Number(revision);
    if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(client) || !Number.isSafeInteger(number) || number < 1) return false;
    const id = `${client}/${provider}`;
    if (number < (clientRevisions.get(id) ?? 0)) return false;
    clientRevisions.set(id, number);
    return true;
  };
  const generation = (provider) => generations.get(provider) ?? 0;
  const mutate = (provider, operation) => {
    const pending = (queues.get(provider) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(provider, pending);
    return pending;
  };
  const snapshot = async (provider) => ({ saved: await store.status(provider), verification: statuses.get(provider)?.verification ?? 'unchecked', ...(statuses.get(provider)?.reason ? { reason: statuses.get(provider).reason } : {}) });
  const forget = async (provider) => {
    // Invalidate immediately, before waiting for a save already in progress.
    generations.set(provider, generation(provider) + 1);
    statuses.delete(provider);
    try {
      await mutate(provider, () => store.forget(provider));
      return { saved: false, verification: 'unchecked' };
    } catch {
      const saved = await store.status(provider).catch(() => true);
      if (!saved) return { saved: false, verification: 'unchecked' };
      const result = { saved, verification: 'retryable', reason: 'removal-failed', removalFailed: true };
      statuses.set(provider, result);
      return result;
    }
  };
  return async (req, path, reply) => {
    const match = path.match(/^\/api\/credentials(?:\/([a-z-]+)(?:\/(verify|request))?)?$/);
    if (!match) return false;
    const [, provider, operation] = match;
    if (req.headers.origin !== `http://${req.headers.host}` && req.headers['sec-fetch-site'] !== 'same-origin') {
      reply(403, { error: 'Same-origin access required.' }); return true;
    }
    if (!provider) {
      if (req.method !== 'DELETE') { reply(405, { error: 'DELETE required.' }); return true; }
      if (Object.keys(endpoints).some((id) => !acceptClientRevision(id, req.headers['x-credential-client'], req.headers['x-credential-revision']))) { reply(409, { error: 'Credential operation superseded.' }); return true; }
      const results = Object.fromEntries(await Promise.all(Object.keys(endpoints).map(async (id) => [id, await forget(id)])));
      reply(200, { results, failed: Object.keys(results).filter((id) => results[id].removalFailed) }); return true;
    }
    if (!Object.hasOwn(endpoints, provider)) { reply(404, { error: 'Unsupported saved-key provider.' }); return true; }
    if (!operation && req.method === 'DELETE') {
      if (!acceptClientRevision(provider, req.headers['x-credential-client'], req.headers['x-credential-revision'])) { reply(409, { error: 'Credential operation superseded.' }); return true; }
      reply(200, await forget(provider)); return true;
    }
    let revision = generation(provider);
    const record = (result) => { if (generation(provider) === revision) statuses.set(provider, result); };
    try {
      if (!operation && req.method === 'GET') { reply(200, await snapshot(provider)); return true; }
      if (!operation || req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
        reply(405, { error: 'Use Verify to save a key after verification.' }); return true;
      }
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1048576) { reply(413, { error: 'Request too large.' }); return true; } }
      let value;
      try { value = JSON.parse(body); } catch { reply(400, { error: 'Invalid JSON.' }); return true; }
      const candidate = operation === 'verify' && Object.hasOwn(value, 'key');
      if (candidate && (typeof value.key !== 'string' || !value.key.trim() || value.key.length > 8192 || /[\r\n\0]/.test(value.key))) {
        reply(400, { error: 'Invalid key input.' }); return true;
      }
      if (operation === 'verify') {
        if (!acceptClientRevision(provider, value.clientId, value.revision)) { reply(409, { error: 'Credential operation superseded.' }); return true; }
        // A newer explicit verification supersedes an older pending check/save.
        generations.set(provider, generation(provider) + 1);
        revision = generation(provider);
        record({ verification: 'checking' });
      }
      await (queues.get(provider) ?? Promise.resolve()).catch(() => {});
      const saved = await store.status(provider);
      if (!candidate && !saved) { record({ verification: 'unchecked' }); reply(operation === 'verify' ? 200 : 404, { saved: false, verification: 'unchecked' }); return true; }
      const key = candidate ? value.key.trim() : await store.read(provider);
      if (generation(provider) !== revision) { reply(409, { error: 'Credential operation superseded.' }); return true; }
      if (operation === 'request' && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)) { reply(400, { error: 'Model required.' }); return true; }
      const reserved = new Set(['model','store','instructions','input','messages','text','response_format','tools','tool_choice','max_output_tokens','max_completion_tokens','reasoning']);
      const extra = value.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters) ? value.parameters : {};
      if (Object.keys(extra).some(name => reserved.has(name))) { reply(400, {error:'A parameter conflicts with managed request fields.'}); return true; }
      // OpenAI's authenticated models route is lightweight. Console's public catalog cannot prove authentication;
      // use a single-token request to a paid model already present in the local catalog.
      const target = operation === 'verify' && provider === 'openai' ? 'https://api.openai.com/v1/models' : endpoints[provider];
      const payload = operation === 'verify'
        ? { model: provider === 'opencode-go' ? 'glm-5.3-flash' : 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'OK' }], max_tokens: 1 }
        : provider === 'openai'
          ? { ...extra, model: value.model, store: false, input: value.input, ...(value.reasoning && typeof value.reasoning === 'object' ? {reasoning:value.reasoning} : {}), ...(typeof value.instructions === 'string' ? {instructions:value.instructions} : {}), ...(value.text && typeof value.text === 'object' ? {text:value.text} : {}), ...(value.tools ? {tools:value.tools, tool_choice:value.tool_choice ?? 'auto'} : {}), ...(Number.isSafeInteger(value.max_output_tokens) && value.max_output_tokens > 0 ? { max_output_tokens: value.max_output_tokens } : {}) }
          : { ...extra, model: value.model, messages: value.messages, ...(value.response_format && typeof value.response_format === 'object' ? {response_format:value.response_format} : {}), ...(value.tools ? {tools:value.tools, tool_choice:value.tool_choice ?? 'auto'} : {}), ...(Number.isSafeInteger(value.max_completion_tokens) && value.max_completion_tokens > 0 ? { max_completion_tokens: value.max_completion_tokens } : {}) };
      const response = await fetcher(target, {
        method: operation === 'verify' && provider === 'openai' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(operation === 'verify' ? 30000 : 120000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        ...(operation === 'verify' && provider === 'openai' ? {} : { body: JSON.stringify(payload) }),
      });
      if (operation === 'verify') {
        if (generation(provider) !== revision) { reply(409, { error: 'Credential operation superseded.' }); return true; }
        if (!response.ok) {
          const result = { saved, verification: response.status === 401 ? 'not-authorized' : 'retryable', reason: response.status === 429 ? 'rate-limit' : response.status === 403 ? 'permission' : `http-${response.status}` };
          record(result); reply(200, result); return true;
        }
        if (candidate) {
          let committed = false;
          await mutate(provider, async () => {
            if (generation(provider) !== revision) return;
            await store.save(provider, key);
            committed = generation(provider) === revision;
          });
          if (!committed) { reply(409, { error: 'Credential operation superseded.' }); return true; }
        }
        const result = { saved: true, verification: 'verified' };
        record(result); reply(200, result); return true;
      }
      if (!response.ok) { const data = await response.json().catch(() => null); reply(502, { error: `Provider request failed (${response.status}).`, providerError: providerError(response.status, data) }); return true; }
      const serialized = JSON.stringify(await response.json());
      reply(200, JSON.parse(serialized.split(JSON.stringify(key).slice(1, -1)).join('[redacted]'))); return true;
    } catch (error) {
      if (generation(provider) !== revision) { reply(409, { error: 'Credential operation superseded.' }); return true; }
      if (operation === 'verify') {
        const result = { saved: await store.status(provider).catch(() => true), verification: 'retryable', reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network-or-store' };
        record(result); reply(200, result); return true;
      }
      reply(503, { error: 'Saved credential operation unavailable.' }); return true;
    }
  };
}
