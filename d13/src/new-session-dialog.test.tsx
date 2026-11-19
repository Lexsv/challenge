import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { canCreateSession, NewSessionFields, SessionTypeFields } from './new-session-dialog';
import { demoWorkers } from './worker-ui';
import { sampleUsers, updateMockUser } from './users-page';

describe('new session dialog',()=>{
  it('orders the fields and only shows the worker selector for Worker sessions',()=>{
    const render=(type:'chat'|'worker')=>renderToStaticMarkup(<NewSessionFields name="Planning" userId="general" users={sampleUsers} onNameChange={()=>{}} onUserChange={()=>{}}><SessionTypeFields sessionType={type} workerId={type==='worker'?'quiz':''} workers={demoWorkers} onTypeChange={()=>{}} onWorkerChange={()=>{}} /></NewSessionFields>);
    for (const type of ['chat','worker'] as const) {
      const html=render(type);
      const name=html.indexOf('Session Name');
      const user=html.indexOf('>User<');
      const sessionType=html.indexOf('Session Type');
      expect(name).toBeGreaterThanOrEqual(0);
      expect(user).toBeGreaterThan(name);
      expect(sessionType).toBeGreaterThan(user);
      if(type==='worker') expect(html.indexOf('Worker Template')).toBeGreaterThan(sessionType);
      else expect(html).not.toContain('Worker Template');
    }
  });
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
