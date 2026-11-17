import { afterEach, expect, it, vi } from 'vitest';
import { loadPersonalizationSnapshot, PersonalizationError } from './week3-session-api';

afterEach(()=>vi.unstubAllGlobals());
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

it('fetches a fresh frozen session-bound snapshot for each turn',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({ok:true,data:{sessionId:'s',profileId:'p',profileRevision:1,habits:'  old\nvalue  '}})).mockResolvedValueOnce(response({ok:true,data:{sessionId:'s',profileId:'p',profileRevision:2,habits:'new'}}));
  vi.stubGlobal('fetch',fetcher);
  const first=await loadPersonalizationSnapshot('s'),second=await loadPersonalizationSnapshot('s');
  expect(Object.isFrozen(first)).toBe(true);expect(first).toEqual({sessionId:'s',profileId:'p',profileRevision:1,habits:'  old\nvalue  '});
  expect(second.profileRevision).toBe(2);expect(second.habits).toBe('new');expect(first.habits).toBe('  old\nvalue  ');
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher).toHaveBeenCalledWith('/api/week3/sessions/s/profile',{cache:'no-store'});
});

it.each(['session_not_found','profile_not_found','invalid_association','database_error'] as const)('preserves the %s outcome',async code=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({ok:false,error:code},code==='session_not_found'?404:code==='database_error'?503:409)));
  await expect(loadPersonalizationSnapshot('s')).rejects.toMatchObject({code});
});

it('fails closed on transport errors, malformed or mismatched data',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error('internal')).mockResolvedValueOnce(response({ok:true,data:{sessionId:'other',profileId:'p',profileRevision:1,habits:''}})).mockResolvedValueOnce(response({ok:true,data:{sessionId:'s',profileId:'general',profileRevision:1,habits:'not empty'}}));
  vi.stubGlobal('fetch',fetcher);
  await expect(loadPersonalizationSnapshot('s')).rejects.toMatchObject({code:'unavailable'});
  await expect(loadPersonalizationSnapshot('s')).rejects.toMatchObject({code:'invalid_association'});
  await expect(loadPersonalizationSnapshot('s')).rejects.toBeInstanceOf(PersonalizationError);
});
