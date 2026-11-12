import {expect,it,vi,afterEach} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createProviderRegistry} from './provider-registry';
import {loadModelCatalog,saveModelCatalog,type CatalogStorage} from './model-catalog-storage';
import {modelCapabilityRows} from './model-capabilities';
import {ProviderModelTable} from './provider-model-table';
import {DEFAULT_ENDPOINTS} from './provider-endpoints';

afterEach(()=>vi.restoreAllMocks());
const fixture={data:[
 {id:'deepseek-v4.1-flash',name:'Example multimodal',limit:{context:1000000,output:32000},cost:{text:{input:{price:0.3},output:{price:1.2}}},modalities:{input:['text','JPEG','PNG','application/pdf'],output:['text','image/png']},capabilities:{structured_output:true,temperature:false,tools:{supported:true},reasoning:{supported:true,levels:['low','high']}}},
 {id:'gpt-6-luna',modalities:{input:['text'],output:['text']},capabilities:{tools:{supported:true},reasoning:{supported:true}}},
 {id:'gpt-5.5'},
]};
function storage(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}};}

it('one Refresh Models persists the complete public catalog and restores identical icons/details without another request',async()=>{
 const cache=storage();const options={catalogStorage:()=>cache};
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(fixture)));
 const first=createProviderRegistry(undefined,{},options);
 await first.get('opencode-console')!.discover!();
 expect(fetcher).toHaveBeenCalledOnce();
 const rows=modelCapabilityRows(first.get('opencode-console')!.modelFeatures!('deepseek-v4.1-flash'));
 expect(rows).toContainEqual({kind:'Image',value:'Input & Output'});expect(rows).toContainEqual({kind:'PDF',value:'Input'});
 const markup=(registry:typeof first)=>renderToStaticMarkup(<ProviderModelTable ids={fixture.data.map(m=>m.id)} registry={registry} provider="opencode-console" selectedModel="deepseek-v4.1-flash" view="models" onConfigure={()=>{}}/>);
 const before=markup(first);
 // A fresh registry has no shared discovered Map: this is the reload boundary.
 const reloaded=createProviderRegistry(undefined,{},options);
 expect(modelCapabilityRows(reloaded.get('opencode-console')!.modelFeatures!('deepseek-v4.1-flash'))).toEqual(rows);
 expect(reloaded.get('opencode-console')!.limits!('deepseek-v4.1-flash')).toMatchObject({contextWindow:1000000,maxOutputTokens:32000,price:{input:0.3,output:1.2}});
 expect(markup(reloaded)).toBe(before);expect(before).toContain('+3');
 expect(before).toContain('Capabilities for gpt-6-luna: Text, Reasoning, Tools');
 expect(reloaded.get('opencode-console')!.modelFeatures!('gpt-5.5')).toBeUndefined();
 expect(fetcher).toHaveBeenCalledOnce();
});

it('replaces saved capabilities on refresh, including explicit false and missing metadata',async()=>{
 const cache=storage(),options={catalogStorage:()=>cache};
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(fixture)));
 const registry=createProviderRegistry(undefined,{},options);await registry.get('opencode-console')!.discover!();
 fetcher.mockResolvedValue(new Response(JSON.stringify({data:[{id:'deepseek-v4.1-flash',capabilities:{tools:{supported:false},reasoning:{supported:false}}},{id:'gpt-6-luna'}]})));
 await registry.get('opencode-console')!.discover!();
 const reload=createProviderRegistry(undefined,{},options);
 expect(reload.get('opencode-console')!.modelFeatures!('deepseek-v4.1-flash')).toEqual({tools:false,reasoning:false});
 expect(reload.get('opencode-console')!.modelFeatures!('gpt-6-luna')).toBeUndefined();
});

it('isolates endpoint caches and rejects a late response after switching endpoints',async()=>{
 const cache=storage(),options={catalogStorage:()=>cache};
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(fixture)));
 const registry=createProviderRegistry(undefined,{},options);await registry.get('opencode-console')!.discover!();
 const endpoint=DEFAULT_ENDPOINTS['opencode-console'];
 registry.setEndpoint('opencode-console','https://example.test/inference/openai/v1/chat/completions',true);
 expect(registry.get('opencode-console')!.modelFeatures!('deepseek-v4.1-flash')).toBeUndefined();
 let finish!:(response:Response)=>void;fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
 const pending=registry.get('opencode-console')!.discover!();
 registry.setEndpoint('opencode-console',endpoint,true);
 finish(new Response(JSON.stringify({data:[{id:'late',modalities:{input:['audio']}}]})));
 await expect(pending).rejects.toThrow('Endpoint changed');
 expect(registry.get('opencode-console')!.modelFeatures!('deepseek-v4.1-flash')).toBeDefined();
 expect(registry.get('opencode-console')!.modelFeatures!('late')).toBeUndefined();
});

it('tolerates absent, old or malformed snapshots and saves only allowlisted public data',()=>{
 const cache=storage(),endpoint=DEFAULT_ENDPOINTS['opencode-console'];
 expect(loadModelCatalog(endpoint)).toEqual([]);
 for(const value of ['bad','{"version":0,"data":[]}','{"version":1,"data":[null,{"id":4}]}']){
  cache.getItem=()=>value;expect(loadModelCatalog(endpoint,cache)).toEqual([]);
 }
 const models=[{id:'safe',name:'Safe',features:{input:['text']},unrelated:'excluded-placeholder'}];
 const output=storage();saveModelCatalog(endpoint,models,output);
 expect([...output.values.values()][0]).not.toContain('excluded-placeholder');
 expect(loadModelCatalog(endpoint,output)).toEqual([{id:'safe',name:'Safe',features:{input:['text']}}]);
 const unavailable:CatalogStorage={getItem:()=>{throw Error('Unavailable')},setItem:()=>{throw Error('Unavailable')}};
 expect(loadModelCatalog(endpoint,unavailable)).toEqual([]);
});
