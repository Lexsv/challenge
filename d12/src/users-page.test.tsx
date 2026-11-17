import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadProfiles, UsersPage, UsersView, type ContextProfile } from './users-page';

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
