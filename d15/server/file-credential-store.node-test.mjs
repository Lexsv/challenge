import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from './file-credential-store.mjs';

test('stores synthetic credentials privately and restores after a new instance', async () => {
  const root=await mkdtemp(join(tmpdir(),'d11-credential-test-'));
  try {
    const dir=join(root,'keys'), first=new FileCredentialStore(dir);
    assert.equal(await first.status('openai'),false);
    await first.save('openai','synthetic-test-value');
    assert.equal((await stat(dir)).mode & 0o777,0o700);
    assert.equal((await stat(join(dir,'openai'))).mode & 0o777,0o600);
    const second=new FileCredentialStore(dir);
    assert.equal(await second.read('openai'),'synthetic-test-value');
    await second.forget('openai');assert.equal(await second.status('openai'),false);
    await assert.rejects(()=>second.save('../unsafe','dummy'));
    await symlink('/dev/null',join(dir,'openai'));await assert.rejects(()=>second.read('openai'));
  } finally {await rm(root,{recursive:true,force:true});}
});
