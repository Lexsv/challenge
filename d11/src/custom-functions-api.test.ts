import {afterEach,expect,it,vi} from 'vitest';
import {deleteFunction,loadFunctions,saveFunction} from './custom-functions-api';

afterEach(()=>vi.unstubAllGlobals());
it('sends exact raw pseudocode and rejects failed writes',async()=>{
 const item={id:'tool-1',name:'Example',description:'Test',pseudocode:'  input x\nreturn x\n'};
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>item}).mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce({ok:false,status:500});
 vi.stubGlobal('fetch',fetcher);
 expect(await saveFunction(item,'create')).toEqual(item);
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(item);
 await expect(saveFunction(item,'edit')).rejects.toThrow('(503)');
 await expect(deleteFunction(item.id)).rejects.toThrow('(500)');
});
it('rejects malformed saved Functions',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>[{id:'x'}]}));
 await expect(loadFunctions()).rejects.toThrow('Invalid Function response');
});
