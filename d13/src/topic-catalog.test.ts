import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';

it('returns isolated, bounded, stable pages without reading or changing historical data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-catalog-'));const db=new DatabaseSync(join(dir,'test.sqlite'));
  try {
    createWeek3Routes(db,()=>null);
    const addSession=db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)');addSession.run('a','A',1);addSession.run('b','B',1);
    const repo=createTopicRepository(db);
    expect(repo.catalog('a')).toEqual({topics:[],nextCursor:null});
    const insert=db.prepare('INSERT INTO week3_topics(session_id,topic_key,value,status,revision) VALUES (?,?,?,?,?)');
    insert.run('b','Topic 001','other session','uncertain',7);
    insert.run('a','Topic 050','value 50','confirmed',2);
    expect(repo.catalog('a')).toEqual({topics:[{key:'Topic 050',value:'value 50',status:'confirmed',revision:2}],nextCursor:null});
    for(let i=100;i>=0;i--){if(i===50)continue;insert.run('a',`Topic ${String(i).padStart(3,'0')}`,`value ${i}`,'confirmed',1);}
    const before=db.prepare('SELECT total_changes() AS count').get();
    db.exec('PRAGMA query_only=ON');
    const first=repo.catalog('a'),second=repo.catalog('a',{after:first.nextCursor!}),third=repo.catalog('a',{after:second.nextCursor!});
    expect(first.topics).toHaveLength(50);expect(first.nextCursor).toBe('Topic 049');
    expect(second.topics).toHaveLength(50);expect(second.nextCursor).toBe('Topic 099');
    expect(third.topics).toEqual([{key:'Topic 100',value:'value 100',status:'confirmed',revision:1}]);expect(third.nextCursor).toBeNull();
    expect([...first.topics,...second.topics,...third.topics].map(x=>x.key)).toEqual(Array.from({length:101},(_,i)=>`Topic ${String(i).padStart(3,'0')}`));
    expect(repo.catalog('a',{limit:2})).toEqual(repo.catalog('a',{limit:2}));
    expect(repo.catalog('b')).toEqual({topics:[{key:'Topic 001',value:'other session',status:'uncertain',revision:7}],nextCursor:null});
    expect(repo.catalog('missing')).toEqual({topics:[],nextCursor:null});
    expect(repo.catalog('a',{after:'topic 049',limit:1}).topics[0].key).toBe('Topic 050');
    for(const limit of [0,101,1.5])expect(()=>repo.catalog('a',{limit})).toThrow('pagination');
    expect(()=>repo.catalog('',{})).toThrow('catalog');expect(()=>repo.catalog('a',{after:''})).toThrow('pagination');
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

it('prevents ASCII case-only duplicate keys in a session and pages each eligible key once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-catalog-case-'));const db=new DatabaseSync(join(dir,'test.sqlite'));
  try {
    createWeek3Routes(db,()=>null);
    const addSession=db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)');addSession.run('a','A',1);addSession.run('b','B',1);
    const insert=db.prepare('INSERT INTO week3_topics(session_id,topic_key,value,status,revision) VALUES (?,?,?,?,?)');
    insert.run('a','Project','first','confirmed',1);
    expect(()=>insert.run('a','project','duplicate','confirmed',1)).toThrow(/UNIQUE constraint failed/i);
    expect(()=>insert.run('a','PROJECT','duplicate','confirmed',1)).toThrow(/UNIQUE constraint failed/i);
    // Different sessions may independently use the same case-insensitive key.
    insert.run('b','project','other session','confirmed',1);
    insert.run('a','Before','before','confirmed',1);insert.run('a','Project A','after','confirmed',1);
    // SQLite NOCASE folds ASCII only: these distinct non-ASCII keys can coexist.
    insert.run('a','Ä','upper','confirmed',1);insert.run('a','ä','lower','confirmed',1);
    const repo=createTopicRepository(db);const seen:string[]=[];let after:string|undefined;
    do {const page=repo.catalog('a',{limit:1,...(after===undefined?{}:{after})});seen.push(...page.topics.map(topic=>topic.key));after=page.nextCursor ?? undefined;} while(after!==undefined);
    expect(seen).toEqual(['Before','Project','Project A','Ä','ä']);expect(new Set(seen).size).toBe(5);
    expect(repo.catalog('a',{limit:1,after:'PROJECT'}).topics[0].key).toBe('Project A');
    expect(repo.catalog('b',{limit:1}).topics.map(topic=>topic.key)).toEqual(['project']);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
