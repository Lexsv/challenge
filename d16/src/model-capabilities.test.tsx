import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseModels } from './opencode-catalog';
import { compactCapabilities, modelCapabilityRows, parseModelFeatures } from './model-capabilities';
import { createProviderRegistry } from './provider-registry';
import { ProviderModelTable } from './provider-model-table';
import { ModelCapabilitiesCell } from './model-capabilities-cell';
afterEach(()=>vi.restoreAllMocks());
const multimodal={id:'multimodal',modalities:{input:['video/mp4','audio/wav','image/jpeg','PNG','gif','webp','application/pdf','text'],output:['text','image/png']},capabilities:{tools:{supported:true},reasoning:{supported:true,levels:['low','medium','high']}}};
it('normalizes image formats once, keeps PDF separate and preserves directions and reasoning levels',()=>{
 const model=parseModels({data:[multimodal]})[0];
 const rows=modelCapabilityRows(model.features);
 expect(rows).toEqual([
  {kind:'Video',value:'Input'},{kind:'Audio',value:'Input'}, {kind:'Image',value:'Input & Output'},
  {kind:'PDF',value:'Input'},{kind:'Text',value:'Input & Output'},
  {kind:'Reasoning',value:'Supported',levels:['low','medium','high']},{kind:'Tools',value:'Supported'}
 ]);
 expect(compactCapabilities(rows)).toEqual({visible:rows.slice(0,2),remaining:5});
});
it('shows all three icons and no badge for three capabilities; does not infer unsupported or missing features',()=>{
 const rows=modelCapabilityRows(parseModelFeatures({modalities:{input:['text'],output:['text']},capabilities:{reasoning:{supported:true},tools:{supported:true}}}));
 expect(rows.map(r=>r.kind)).toEqual(['Text','Reasoning','Tools']);
 expect(compactCapabilities(rows)).toEqual({visible:rows,remaining:0});
 expect(parseModelFeatures({})).toBeUndefined();
 expect(modelCapabilityRows(parseModelFeatures({capabilities:{tools:{supported:false},reasoning:{supported:false}}}))).toEqual([]);
 expect(modelCapabilityRows(parseModelFeatures({modalities:{input:[null,12,{},'unknown-format']},capabilities:{tools:{supported:'true'}}}))).toEqual([]);
 const missing=renderToStaticMarkup(<ModelCapabilitiesCell model="missing"/>);
 expect(missing).toContain('—');expect(missing).not.toContain('<button');
});
it('supports output-only modalities and collapses repeated formats',()=>{
 expect(modelCapabilityRows(parseModelFeatures({modalities:{output:['video','audio','image/jpeg','jpeg','pdf','text']}}))).toEqual(
  ['Video','Audio','Image','PDF','Text'].map(kind=>({kind,value:'Output'}))
 );
});
it('uses Refresh Models metadata independently of structured output and replaces it on refresh',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[multimodal,{id:'three',modalities:{input:['text']},capabilities:{tools:{supported:true},reasoning:{supported:true}}},{id:'missing'}]})));
 const registry=createProviderRegistry();await registry.get('opencode-console')!.discover!();
 expect(fetcher).toHaveBeenCalledOnce();
 expect(registry.capabilitiesFor('opencode-console','multimodal')).toBeUndefined();
 const features=registry.get('opencode-console')!.modelFeatures!('multimodal');
 expect(modelCapabilityRows(features)).toHaveLength(7);
 const html=renderToStaticMarkup(<ProviderModelTable ids={['multimodal','three','missing']} provider="opencode-console" selectedModel="three" view="models" registry={registry} onConfigure={()=>{}}/>);
 expect(html.indexOf('Structured output')).toBeLessThan(html.indexOf('Capabilities</th>'));
 expect(html.indexOf('Capabilities</th>')).toBeLessThan(html.indexOf('Options</th>'));
 expect(html).toContain('+5');expect(html).toContain('Capabilities for multimodal: Video, Audio, Image, PDF, Text, Reasoning, Tools');
 expect(html).toContain('Capabilities for three: Text, Reasoning, Tools');
 expect(html).toContain('Configure model three');
 expect(html).toContain('aria-haspopup="dialog"');expect(html).toContain('aria-expanded="false"');
 const openai=renderToStaticMarkup(<ProviderModelTable ids={['gpt-4o-mini']} provider="openai" selectedModel="gpt-4o-mini" view="models" registry={registry} onConfigure={()=>{}}/>);
 expect(openai).not.toContain('Capabilities</th>');
 fetcher.mockResolvedValue(new Response(JSON.stringify({data:[{id:'multimodal'}]})));
 await registry.get('opencode-console')!.discover!();
 expect(registry.get('opencode-console')!.modelFeatures!('multimodal')).toBeUndefined();
});
