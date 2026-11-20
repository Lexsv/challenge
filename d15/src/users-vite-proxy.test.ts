import { expect, it } from 'vitest';
import { createServer, mergeConfig } from 'vite';
import { createSessionServer } from '../server/sessions.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../vite.config';

it('proxies profiles and existing session routes through Vite', async () => {
  const proxy = config.server!.proxy!;
  for(const route of ['/api/credentials','/api/users','/api/week3/sessions','/api/sessions','/api/functions','/api/worker-templates','/api/worker-sessions']) {
    expect(proxy[route]).toEqual({target:'http://127.0.0.1:3015'});
  }
  expect(proxy['^/__d5_opencode_console/(chat/completions|responses|models)$']).toMatchObject({target:'https://opencode.ai',changeOrigin:true});
  const overridden=mergeConfig(config,{server:{proxy:{'/api/users':{target:'http://127.0.0.1:3999'}}}});
  expect(overridden.server!.proxy!['/api/users']).toEqual({target:'http://127.0.0.1:3999'});
  expect(overridden.server!.proxy!['/api/sessions']).toEqual({target:'http://127.0.0.1:3015'});
  const dir=await mkdtemp(join(tmpdir(),'d12-vite-proxy-'));
  let backend:ReturnType<typeof createSessionServer>|undefined;
  let vite:Awaited<ReturnType<typeof createServer>>|undefined;
  try {
    backend=createSessionServer(join(dir,'isolated.sqlite'));
    await new Promise<void>(resolve=>backend!.listen(0,'127.0.0.1',resolve));
    const address=backend.address(); if(!address || typeof address==='string')throw Error('No backend port');
    const target=`http://127.0.0.1:${address.port}`;
    vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,proxy:{...proxy,
      '/api/users':{...proxy['/api/users'] as object,target},
      '/api/worker-templates':{...proxy['/api/worker-templates'] as object,target},
      '/api/worker-sessions':{...proxy['/api/worker-sessions'] as object,target},
      '/api/sessions':{...proxy['/api/sessions'] as object,target},
      '/api/week3/sessions':{...proxy['/api/week3/sessions'] as object,target}}}});
    await vite.listen();
    const front=vite.httpServer!.address(); if(!front || typeof front==='string')throw Error('No frontend port');
    const base=`http://127.0.0.1:${front.port}`;
    const users=await fetch(`${base}/api/users`);expect(users.status).toBe(200);expect(await users.json()).toMatchObject([{id:'general',name:'General'}]);
    const workers=await fetch(`${base}/api/worker-templates`);expect(workers.status).toBe(200);expect((await workers.json()).map((item:{name:string})=>item.name)).toEqual(expect.arrayContaining(['Programming Quiz','Chocolate Production']));
    expect((await fetch(`${base}/api/worker-sessions`)).status).toBe(200);
    for(const path of ['/api/sessions','/api/week3/sessions']) {const response=await fetch(`${base}${path}`);expect(response.status).toBe(200);expect(await response.json()).toEqual([]);}
  } finally {
    if(vite)await vite.close();
    if(backend?.listening)await new Promise<void>((resolve,reject)=>backend!.close((error:Error|undefined)=>error?reject(error):resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
