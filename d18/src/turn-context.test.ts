import { describe, expect, it, vi } from 'vitest';
import { createTurnContextStore } from '../server/turn-context';
import type { PersonalizationSnapshot } from './week3-session-api';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {createContextProfileRepository}=require('../server/context-profile-repository.mjs') as {createContextProfileRepository:(db:DatabaseSync)=>{create(name:string,habits:string):{id:string};update(id:string,name:string,habits:string,revision:number):unknown}};
const {resolveSessionPersonalization}=require('../server/session-personalization.mjs') as {resolveSessionPersonalization:(db:DatabaseSync,id:string)=>{ok:true;data:PersonalizationSnapshot}|{ok:false;error:string}};

const refs={sessionId:'session-1',runId:'run-1',messageId:'message-1'};
const initial:PersonalizationSnapshot={sessionId:refs.sessionId,profileId:'profile-1',profileRevision:2,habits:'* Use diagrams.\nLegacy'};
const setup=(overrides:Partial<{ttlMs:number;maxEntries:number}>={})=>{
  let time=100;
  const current={...initial};
  const resolve=vi.fn((sessionId:string)=>sessionId===refs.sessionId ? {ok:true as const,data:current} : {ok:false as const,error:'session_not_found'});
  const store=createTurnContextStore({resolve,now:()=>time,ttlMs:10,maxEntries:3,...overrides});
  return {store,current,resolve,advance:(ms:number)=>{time+=ms;}};
};
function issued(store:ReturnType<typeof setup>['store']) {const result=store.create(refs);if(!result.ok)throw Error(result.error);return result;}

describe('server turn context',()=>{
  it('captures the existing SQLite resolver snapshot independently of later profile changes',()=>{
    const db=new DatabaseSync(':memory:');
    try{
      const profiles=createContextProfileRepository(db),profile=profiles.create('Synthetic','* Old.');
      db.exec('CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES context_profiles(id))');
      db.prepare('INSERT INTO week3_sessions VALUES(?,?)').run(refs.sessionId,profile.id);
      const store=createTurnContextStore({resolve:id=>resolveSessionPersonalization(db,id)}),entry=issued(store);
      profiles.update(profile.id,'Synthetic','* New.',1);
      const consumed=store.consume(entry.token,refs);
      expect(consumed).toMatchObject({ok:true,context:{snapshot:{profileId:profile.id,profileRevision:1,habits:'* Old.'}}});
    }finally{db.close();}
  });
  it('creates an opaque random token and consumes a frozen server snapshot once',()=>{
    const f=setup(),first=issued(f.store),second=f.store.create({...refs,runId:'run-2'});
    if(!second.ok)throw Error('fixture');
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(first.token).not.toBe(second.token);
    expect(first.token).not.toContain('profile');expect(first.snapshot).toEqual(initial);
    f.current.habits='changed';f.current.profileRevision=3;
    const result=f.store.consume(first.token,refs);
    expect(result).toEqual({ok:true,context:{...refs,snapshot:initial}});
    if(result.ok){expect(Object.isFrozen(result.context)).toBe(true);expect(Object.isFrozen(result.context.snapshot)).toBe(true);}
    expect(f.store.consume(first.token,refs)).toEqual({ok:false,error:'not_found'});
    expect(f.store.size()).toBe(1);
  });
  it.each(['sessionId','runId','messageId'] as const)('rejects mismatched %s without consuming the token',key=>{
    const f=setup(),entry=issued(f.store);
    expect(f.store.consume(entry.token,{...refs,[key]:'other'})).toEqual({ok:false,error:'mismatch'});
    expect(f.store.consume(entry.token,refs).ok).toBe(true);
  });
  it('rejects expired contexts and lazily prunes expired entries',()=>{
    const f=setup(),first=issued(f.store);expect(f.store.create({...refs,runId:'run-2'}).ok).toBe(true);f.advance(10);
    expect(f.store.consume(first.token,refs)).toEqual({ok:false,error:'expired'});
    expect(f.store.size()).toBe(0);expect(f.store.create(refs).ok).toBe(true);
  });
  it('allows only one of concurrent consumers',async()=>{
    const f=setup(),entry=issued(f.store);
    const results=await Promise.all(Array.from({length:5},()=>Promise.resolve().then(()=>f.store.consume(entry.token,refs))));
    expect(results.filter(result=>result.ok)).toHaveLength(1);
    expect(results.filter(result=>!result.ok)).toHaveLength(4);
  });
  it('rejects unknown tokens and loses all contexts after restart',()=>{
    const first=setup(),entry=issued(first.store),restarted=setup();
    expect(restarted.store.consume(entry.token,refs)).toEqual({ok:false,error:'not_found'});
    expect(first.store.consume('x'.repeat(43),refs)).toEqual({ok:false,error:'not_found'});
    expect(first.store.consume('bad',refs)).toEqual({ok:false,error:'invalid_reference'});
  });
  it('bounds memory without evicting a valid context',()=>{
    const f=setup({maxEntries:1}),entry=issued(f.store);
    expect(f.store.create({...refs,runId:'another'})).toEqual({ok:false,error:'capacity'});
    expect(f.store.consume(entry.token,refs).ok).toBe(true);expect(f.store.create(refs)).toEqual({ok:false,error:'duplicate'});
    f.advance(10);expect(f.store.create(refs).ok).toBe(true);
  });
  it('accepts the General snapshot without any write path',()=>{
    const resolve=vi.fn(()=>({ok:true as const,data:{sessionId:refs.sessionId,profileId:'general',profileRevision:1,habits:''}}));
    const store=createTurnContextStore({resolve}),entry=issued(store);
    expect(entry.snapshot).toMatchObject({profileId:'general',habits:''});expect(store.consume(entry.token,refs).ok).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
  });
  it('rejects caller-provided snapshots and invalid or unavailable resolver results',()=>{
    const f=setup();
    expect(f.store.create({...refs,profileId:'p',habits:'fake'} as typeof refs)).toEqual({ok:false,error:'invalid_reference'});
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.store.create({...refs,sessionId:'missing'})).toEqual({ok:false,error:'unavailable'});
    const invalid=createTurnContextStore({resolve:()=>({ok:true,data:{...initial,sessionId:'another'}})});
    expect(invalid.create(refs)).toEqual({ok:false,error:'unavailable'});
    const badGeneral=createTurnContextStore({resolve:()=>({ok:true,data:{...initial,profileId:'general'}})});
    expect(badGeneral.create(refs)).toEqual({ok:false,error:'unavailable'});
  });
  it('rejects invalid configuration and returns sanitized resolution errors',()=>{
    expect(()=>createTurnContextStore({resolve:()=>({ok:false,error:'x'}),maxEntries:0})).toThrow('Invalid turn context store configuration.');
    const store=createTurnContextStore({resolve:()=>{throw new Error('internal detail');}});
    expect(store.create(refs)).toEqual({ok:false,error:'unavailable'});
  });
});
