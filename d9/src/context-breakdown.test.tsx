import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createManagerConversation, ManagerAgent } from './manager-agent';
import { ToolRegistry } from './tool-runtime';
import { ContextBreakdownPanel, estimateContextBreakdown, SessionStatsContent } from './session-stats-panel';

it('uses the saved coverage marker and Manager message groups for all layers',async()=>{
 const state=createManagerConversation(),manager=new ManagerAgent({complete:async()=>({text:'Answer'})},new ToolRegistry());
 for(let i=0;i<10;i++) await manager.run({state,userText:`Message ${i}`});
 const saved={facts:[{subject:'Project',attribute:'budget',value:'100 dollars'}],coveredMessageId:state.messages[2].id};
 const value=await estimateContextBreakdown(state,saved,10,'gpt-4o-mini');
 expect(value.bufferCount).toBe(7);expect(value.dialogue).toBeGreaterThan(value.buffer);expect(value.facts).toBeGreaterThan(0);
 expect((await estimateContextBreakdown(state,{...saved,coveredMessageId:state.messages[9].id},10,'gpt-4o-mini')).bufferCount).toBe(0);
 expect((await estimateContextBreakdown(state,saved,7,'gpt-4o-mini')).bufferCount).toBe(10);
});
it.each([[0,'Below threshold'],[6,'Below threshold'],[7,'Near threshold'],[10,'Full'],[11,'Full']])('renders occupancy %s with textual status', (bufferCount,status)=>{
 const html=renderToStaticMarkup(<ContextBreakdownPanel value={{dialogue:100,facts:5,buffer:25,recent:40,bufferCount,window:10}}/>);
 expect(html).toContain(`${bufferCount} / 10 messages`);expect(html).toContain(status);
 expect(html.indexOf('Dialogue')).toBeLessThan(html.indexOf('Fact context'));expect(html.indexOf('Buffer')).toBeLessThan(html.indexOf('Compression'));
 expect(html).toContain('prefers-reduced-motion');
});
it('shows the context indicator only when requested for Key Facts',()=>{
 expect(renderToStaticMarkup(<SessionStatsContent/>)).not.toContain('Context breakdown');
 const html=renderToStaticMarkup(<SessionStatsContent showBreakdown/>);
 expect(html.indexOf('Last request')).toBeLessThan(html.indexOf('Context breakdown'));
 expect(html).toContain('Context breakdown');
});
it('uses occupancy for the buffer bar while other bars use token proportions',()=>{
 const html=renderToStaticMarkup(<ContextBreakdownPanel value={{dialogue:1000,facts:100,buffer:50,recent:400,bufferCount:7,window:10}}/>);
 expect(html).toContain('width:70%');expect(html).toContain('width:10%');expect(html).toContain('10%');
 const full=renderToStaticMarkup(<ContextBreakdownPanel value={{dialogue:1000,facts:100,buffer:50,recent:400,bufferCount:12,window:10}}/>);
 expect(full).toMatch(/width:100%/);expect(full).toContain('Full');
});
it('renders compression and positions the recent estimate above the divider',()=>{
 const value={dialogue:1000,facts:250,buffer:50,recent:400,bufferCount:7,window:10};
 const html=renderToStaticMarkup(<SessionStatsContent showBreakdown breakdown={value}/>);
 expect(html).toContain('25%');expect(html).toContain('width:25%');
 expect(html.indexOf('Last request')).toBeLessThan(html.indexOf('Recent messages'));
 expect(html.indexOf('Recent messages')).toBeLessThan(html.indexOf('aria-label="Context breakdown"'));
 expect(html).not.toContain('Estimated tokens');
 for(const blank of [{...value,dialogue:0},{...value,facts:0}]) {
  const empty=renderToStaticMarkup(<ContextBreakdownPanel value={blank}/>);
  expect(empty).toMatch(/Compression<\/span><span>—/);
 }
 const example=renderToStaticMarkup(<ContextBreakdownPanel value={{...value,dialogue:396,facts:39}}/>);
 expect(example).toContain('10%');expect(example).toContain('width:10%');
});
