import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProfileDeleter, createProfileSaver, DeletionDialog, loadProfiles, UsersPage, UsersView, type ContextProfile } from './users-page';

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
    expect(html).toContain('aria-label="Clear Sessions for General"');
  });
});

describe('profile deletion', () => {
  it('deletes a regular profile and refreshes after success', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:200})), refresh=vi.fn(), pending=vi.fn();
    const remove=createProfileDeleter(fetcher,refresh,pending);
    expect(await remove({kind:'profile',profile:profiles[0]})).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/users/profile-1',{method:'DELETE'});
    expect(refresh).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true],[false]]);
  });
  it('clears General sessions but rejects deleting General', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:200})), refresh=vi.fn();
    const remove=createProfileDeleter(fetcher,refresh,()=>{});
    expect(await remove({kind:'profile',profile:profiles[1]})).toContain('cannot be deleted');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await remove({kind:'clear'})).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/users/general/sessions',{method:'DELETE'});
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('explains permanent deletion, distinguishes actions, and allows cancellation', () => {
    const cancel=vi.fn(), confirm=vi.fn();
    const dialog=DeletionDialog({target:{kind:'profile',profile:profiles[0]},pending:false,error:'',onCancel:cancel,onConfirm:confirm});
    const parts=React.Children.toArray(dialog.props.children) as React.ReactElement<{children?:React.ReactNode}>[];
    const text=renderToStaticMarkup(parts[1]);
    expect(text).toContain('Taylor');expect(text).toContain('sessions, history, and memory will be permanently deleted');
    expect(text).not.toMatch(/\d+ sessions/);
    const actions=React.Children.toArray(parts[2].props.children) as React.ReactElement<{onClick:()=>void}>[];
    actions[0].props.onClick();expect(cancel).toHaveBeenCalledOnce();expect(confirm).not.toHaveBeenCalled();
    actions[1].props.onClick();expect(confirm).toHaveBeenCalledOnce();
    const clear=DeletionDialog({target:{kind:'clear'},pending:false,error:'',onCancel:cancel,onConfirm:confirm});
    const clearParts=React.Children.toArray(clear.props.children) as React.ReactElement<{children?:React.ReactNode}>[];
    expect(renderToStaticMarkup(clearParts[1])).toContain('The General profile will remain');
    const busy=DeletionDialog({target:{kind:'clear'},pending:true,error:'',onCancel:cancel,onConfirm:confirm});
    busy.props.onClose();expect(cancel).toHaveBeenCalledOnce();
  });
  it('keeps failures visible without triggering refresh', async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:500})).mockRejectedValueOnce(new Error('offline'));
    const refresh=vi.fn(), remove=createProfileDeleter(fetcher,refresh,()=>{});
    const error=await remove({kind:'profile',profile:profiles[0]});expect(error).toContain('Could not complete');
    expect(await remove({kind:'clear'})).toContain('Could not confirm');expect(refresh).not.toHaveBeenCalled();
    const dialog=DeletionDialog({target:{kind:'profile',profile:profiles[0]},pending:false,error:error!,onCancel:()=>{},onConfirm:()=>{}});
    const parts=React.Children.toArray(dialog.props.children) as React.ReactElement<{children?:React.ReactNode}>[];
    expect(dialog.props.open).toBe(true);expect(renderToStaticMarkup(parts[1])).toContain('Could not complete');
  });
  it('prevents duplicate requests while a deletion is pending', async () => {
    let resolve!: (response:Response)=>void;
    const fetcher=vi.fn().mockReturnValue(new Promise<Response>(done=>{resolve=done;})), refresh=vi.fn(), pending=vi.fn();
    const remove=createProfileDeleter(fetcher,refresh,pending), target={kind:'clear'} as const;
    const first=remove(target);await remove(target);
    expect(fetcher).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true]]);
    resolve(new Response('{}',{status:200}));await first;
    expect(refresh).toHaveBeenCalledOnce();expect(pending.mock.calls).toEqual([[true],[false]]);
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
