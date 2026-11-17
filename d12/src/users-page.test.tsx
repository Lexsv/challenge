import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProfileSaver, loadProfiles, UsersPage, UsersView, type ContextProfile } from './users-page';

const profiles: ContextProfile[] = [
  {id:'profile-1',name:'Taylor',habits:'Prefers diagrams',is_system:0,revision:2},
  {id:'general',name:'General',habits:'',is_system:1,revision:1},
];

describe('Users profiles', () => {
  it('loads and validates actual profile data from the API', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(profiles),{status:200}));
    await expect(loadProfiles(fetcher)).resolves.toEqual(profiles);
    expect(fetcher).toHaveBeenCalledWith('/api/users',{signal:undefined});
    await expect(loadProfiles(vi.fn().mockResolvedValue(new Response('',{status:500})))).rejects.toThrow();
    await expect(loadProfiles(vi.fn().mockResolvedValue(new Response(JSON.stringify([{id:'bad'}]),{status:200})))).rejects.toThrow();
  });
  it('shows loading, a retryable error, and a distinct empty state', () => {
    expect(renderToStaticMarkup(<UsersPage />)).toContain('Loading profiles');
    const error=renderToStaticMarkup(<UsersView state={{status:'error'}} onRetry={()=>{}} />);
    expect(error).toContain('Could not load profiles'); expect(error).toContain('Retry');
    expect(renderToStaticMarkup(<UsersView state={{status:'loaded',profiles:[]}} onRetry={()=>{}} />)).toContain('No profiles available.');
  });
  it('shows API profiles, General first and neutral session counts, without mock data', () => {
    const html=renderToStaticMarkup(<UsersView state={{status:'loaded',profiles}} onRetry={()=>{}} />);
    expect(html).toContain('General'); expect(html).toContain('Taylor'); expect(html).toContain('Prefers diagrams');
    expect(html.indexOf('>General<')).toBeLessThan(html.indexOf('>Taylor<'));
    expect(html).toContain('aria-label="Habits for Taylor: Prefers diagrams"');
    expect(html).toContain('aria-label="Session count unavailable for General"');
    expect(html).toContain('aria-label="Session count unavailable for Taylor"');
    expect(html).not.toContain('Alex'); expect(html).not.toContain('Developer'); expect(html).not.toContain('Welcome session');
    expect(html).not.toContain('aria-label="Edit General"'); expect(html).not.toContain('aria-label="Delete General"');
    expect(html).toContain('aria-label="Edit Taylor"'); expect(html).toContain('aria-label="Delete Taylor"');
    expect(html).toContain('disabled');
  });
});

describe('profile saving', () => {
  it('creates a profile and requests a refresh after success', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:201}));
    const refresh=vi.fn(), pending=vi.fn(), save=createProfileSaver(fetcher,refresh,pending);
    expect(await save({name:' Taylor ',habits:'Examples'})).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Taylor',habits:'Examples'})});
    expect(refresh).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true],[false]]);
  });
  it('updates with the expected revision and requests a refresh', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:200})), refresh=vi.fn();
    const save=createProfileSaver(fetcher,refresh,()=>{});
    expect(await save({name:'Taylor',habits:'Short',existing:profiles[0]})).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/users/profile-1',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Taylor',habits:'Short',expectedRevision:2})});
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('protects General and reports validation, missing profile, and revision conflict', async () => {
    const fetcher=vi.fn(), refresh=vi.fn(), save=createProfileSaver(fetcher,refresh,()=>{});
    expect(await save({name:'General',habits:'',existing:profiles[1]})).toMatch(/cannot be edited/);
    expect(await save({name:' ',habits:''})).toMatch(/valid name/);expect(fetcher).not.toHaveBeenCalled();
    for(const [status,message] of [[400,'valid name'],[404,'no longer exists'],[409,'changed elsewhere']] as const){
      fetcher.mockResolvedValueOnce(new Response('',{status}));
      expect(await save({name:'Taylor',habits:'',existing:profiles[0]})).toContain(message);
    }
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not submit the same request twice while pending', async () => {
    let resolve!: (response:Response)=>void;
    const fetcher=vi.fn().mockReturnValue(new Promise<Response>(done=>{resolve=done;})), refresh=vi.fn(), pending=vi.fn();
    const save=createProfileSaver(fetcher,refresh,pending), draft={name:'Taylor',habits:''};
    const first=save(draft);await save(draft);
    expect(fetcher).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true]]);
    resolve(new Response('{}',{status:201}));await first;
    expect(refresh).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true],[false]]);
  });
  it('reports network failures without refreshing and releases the pending state', async () => {
    const refresh=vi.fn(), pending=vi.fn();
    const save=createProfileSaver(vi.fn().mockRejectedValue(new Error('network')),refresh,pending);
    expect(await save({name:'Taylor',habits:''})).toBe('Could not save the profile. Please try again.');
    expect(refresh).not.toHaveBeenCalled();expect(pending.mock.calls).toEqual([[true],[false]]);
  });
});
