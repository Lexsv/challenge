import { afterEach, expect, it, vi } from 'vitest';
import { profileName, sessionCounts } from './profile-session-utils';
import { createSession, listSessions } from './week3-session-api';
import { loadProfiles } from './users-page';

const profiles=[{id:'general',name:'General',habits:'',is_system:1 as const,revision:1},{id:'alex',name:'Alex',habits:'',is_system:0 as const,revision:1}];
afterEach(()=>vi.unstubAllGlobals());

it('uses persisted session profile IDs for names and safe counts after changes',()=>{
  const sessions=[{id:'1',title:'One',createdAt:1,profileId:'general'},{id:'2',title:'Two',createdAt:2,profileId:'alex'},{id:'3',title:'Three',createdAt:3,profileId:'alex'}];
  expect(sessionCounts(sessions)).toEqual({general:1,alex:2});
  expect(profileName(sessions[1].profileId,profiles)).toBe('Alex');
  expect(profileName('deleted',profiles)).toBe('Unknown profile');
  expect(profileName(undefined,profiles)).toBe('Unknown profile');
  expect(sessionCounts(sessions.filter(s=>s.id!=='2'))).toEqual({general:1,alex:1});
  expect(sessionCounts(sessions.filter(s=>s.profileId!=='general'))).toEqual({alex:2});
  expect(sessionCounts([{id:'x',title:'X',createdAt:1}])).toBeNull();
});

it('sends selected profileId and preserves legacy empty session creation',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({id:'s',title:'New session',createdAt:1,profileId:'alex'}),{status:200}));
  vi.stubGlobal('fetch',fetcher);
  expect((await createSession('alex')).profileId).toBe('alex');
  expect(fetcher).toHaveBeenNthCalledWith(1,'/api/week3/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:'alex'})});
  await createSession();expect(fetcher).toHaveBeenNthCalledWith(2,'/api/week3/sessions',{method:'POST'});
});

it('loads real choices and reports failures instead of fabricating profiles',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(profiles),{status:200})).mockRejectedValueOnce(new Error('offline'));
  expect(await loadProfiles(fetcher)).toEqual(profiles);await expect(loadProfiles(fetcher)).rejects.toThrow('offline');
});

it('retains profileId from restored session metadata',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify([{id:'s',title:'Restored',createdAt:1,profileId:'alex'}]),{status:200})));
  expect(profileName((await listSessions())[0].profileId,profiles)).toBe('Alex');
});
