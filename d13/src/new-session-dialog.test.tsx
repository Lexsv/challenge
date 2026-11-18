import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { canCreateSession, NewSessionFields } from './new-session-dialog';
import { sampleUsers, updateMockUser } from './users-page';

describe('new session dialog',()=>{
  it('shows required session name and General as the initial user',()=>{
    const html=renderToStaticMarkup(<NewSessionFields name="" userId="general" users={sampleUsers} onNameChange={()=>{}} onUserChange={()=>{}}/>);
    expect(html).toContain('Session Name');expect(html).toContain('General');expect(html).toContain('not saved with the session');
    expect(canCreateSession('','general',sampleUsers,false)).toBe(false);
    expect(canCreateSession('   ','general',sampleUsers,false)).toBe(false);
  });
  it('requires an available user and accepts added mock users without persisting them',()=>{
    const users=updateMockUser(sampleUsers,{id:'sam',name:'Sam',habits:'',sessions:[]});
    expect(canCreateSession('My session','general',users,false)).toBe(true);
    expect(canCreateSession('My session','alex',users,false)).toBe(true);
    expect(canCreateSession('My session','sam',users,false)).toBe(true);
    expect(canCreateSession('My session','missing',users,false)).toBe(false);
    expect(canCreateSession('My session','general',users,true)).toBe(false);
  });
  it('uses supplied real profile choices and explains that ownership is saved',()=>{
    const users=[{id:'general',name:'General'},{id:'real-profile',name:'Real User'}];
    const html=renderToStaticMarkup(<NewSessionFields name="Planning" userId="general" users={users} persisted onNameChange={()=>{}} onUserChange={()=>{}}/>);
    expect(html).toContain('General');expect(html).toContain('saved with the session');
    expect(canCreateSession('Planning','real-profile',users,false)).toBe(true);
    expect(canCreateSession('Planning','alex',users,false)).toBe(false);
    expect(canCreateSession('','general',users,false)).toBe(false);
  });
});
