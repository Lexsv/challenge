import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionListRequests } from './session-list-requests';
import { SessionListErrorNotice } from './week2-agent-tool-lab';

function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (reason:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

it('keeps a newly created session and its selection when an older refresh resolves',async()=>{
  const requests=new SessionListRequests(), old=deferred<string[]>();
  let sessions=['old'], selected='old';
  const refresh=requests.load(()=>old.promise,items=>{sessions=items;selected=items[0] ?? '';},()=>{});
  requests.invalidate();sessions=[...sessions,'new'];selected='new';requests.invalidate();
  old.resolve(['old']);await refresh;
  expect(sessions).toEqual(['old','new']);expect(selected).toBe('new');
});

it('applies only the newest of two refreshes resolving in reverse order',async()=>{
  const requests=new SessionListRequests(), first=deferred<string[]>(), second=deferred<string[]>();
  const apply=vi.fn();
  const one=requests.load(()=>first.promise,apply,()=>{}), two=requests.load(()=>second.promise,apply,()=>{});
  second.resolve(['new']);await two;first.resolve(['old']);await one;
  expect(apply).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledWith(['new']);
});

it('exposes a working retry and applies the retried session list',async()=>{
  const requests=new SessionListRequests(), first=deferred<string[]>(), retry=deferred<string[]>();
  let message='', sessions:string[]=[];let retried:Promise<void> | undefined;
  const apply=(items:string[])=>{sessions=items;message='';};
  const fail=()=>{message='Could not load sessions. Check the local backend and retry.';};
  const firstRequest=requests.load(()=>first.promise,apply,fail);first.reject(new Error('offline'));await firstRequest;
  const notice=SessionListErrorNotice({message,onRetry:()=>{retried=requests.load(()=>retry.promise,apply,fail);}});
  expect(renderToStaticMarkup(notice)).toContain('Retry');
  notice.props.action.props.onClick();retry.resolve(['restored']);await retried;
  expect(sessions).toEqual(['restored']);expect(message).toBe('');
});

it.each(['profile deletion','General session clearing','session deletion'])('%s invalidates stale responses',async()=>{
  const requests=new SessionListRequests(), old=deferred<string[]>(), fresh=deferred<string[]>();
  let sessions=['removed','keep'],selected='removed';
  const apply=(items:string[])=>{sessions=items;selected=items.includes(selected) ? selected : items[0] ?? '';};
  const before=requests.load(()=>old.promise,apply,()=>{});
  requests.invalidate();sessions=['keep'];selected='keep';requests.invalidate();
  const after=requests.load(()=>fresh.promise,apply,()=>{});
  fresh.resolve(['keep']);await after;old.resolve(['removed','keep']);await before;
  expect(sessions).toEqual(['keep']);expect(selected).toBe('keep');
});
