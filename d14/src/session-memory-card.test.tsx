import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LongTermMemoryView, MemoryDetailsContent, SessionMemoryCard } from './session-memory-card';
import type { MemorySnapshot } from './session-memory';

const snapshot:MemorySnapshot={revision:1,data:{covered:[],extracted:[],buffer:[],short:[{id:'run',messages:[{role:'user',content:'Synthetic user message'},{role:'assistant',content:'Synthetic answer'}]}],summary:'A synthetic summary.',facts:[{subject:'Project',attribute:'deadline',value:'Friday',status:'confirmed',sources:['source']} ]}};

it('keeps nonempty memory compact and labels unavailable layer estimates honestly',()=>{
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={snapshot} shortTokens={120} shortLimit={1000} />);
  expect(html).toContain('Session Memory');expect(html).toContain('120 / 1,000');
  expect(html).toContain('Distribution unavailable');expect(html).toContain('—');
  expect(html).not.toContain('Synthetic user message');expect(html).not.toContain('A synthetic summary.');expect(html).not.toContain('Friday');
});
it('renders proportional keyboard-accessible segments when all estimates are supplied',()=>{
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={snapshot} shortTokens={100} summaryTokens={50} factTokens={50} />);
  expect(html).toContain('200');expect(html).toContain('stroke-dasharray="131.94689145077132 263.89378290154264"');
  expect((html.match(/<circle[^>]*role="button"/g) ?? [])).toHaveLength(3);
  expect((html.match(/tabindex="0"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(html).toContain('Open Short-term memory details');expect(html).toContain('Open Medium-term memory details');expect(html).toContain('Open Long-term memory details');
  expect(html).toContain('About Short-term memory');expect(html).toContain('About Medium-term memory');expect(html).toContain('About Long-term memory');
  expect(html).toContain('Recent conversation messages kept in their original form.');
  expect(html).toContain('Compressed summaries of earlier conversations.');
  expect(html).toContain('Persistent key facts extracted from conversations, including updates and version history.');
});
it('attaches descriptions to information controls, not rows or chart segments',()=>{
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={snapshot} shortTokens={100} summaryTokens={50} factTokens={50} />);
  const buttons=html.match(/<button\b[^>]*>/g) ?? [];
  for(const label of ['Short-term memory','Medium-term memory','Long-term memory']){
    const row=buttons.find(button=>button.includes(`aria-label="Open ${label} details"`));
    const info=buttons.find(button=>button.includes(`aria-label="About ${label}"`));
    expect(row).toBeDefined();expect(row).not.toMatch(/\stitle=/);expect(info).toBeDefined();expect(info).toMatch(/\stitle=/);
  }
  const circles=html.match(/<circle\b[^>]*role="button"[^>]*>/g) ?? [];
  expect(circles).toHaveLength(3);for(const circle of circles)expect(circle).not.toMatch(/\stitle=/);
});
it('shows an empty neutral chart when all three layers are empty',()=>{
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={{revision:0,data:null}} shortTokens={0} />);
  expect(html).toContain('context estimates');expect(html).toContain('Long-term sent to model:');expect(html).toContain('full stored facts:');expect(html).not.toContain('Distribution unavailable');expect(html).not.toContain('stroke-dasharray');
});
it('renders each stored category in order without changing the snapshot',()=>{
  const original=structuredClone(snapshot);
  const short=renderToStaticMarkup(<MemoryDetailsContent category="short" data={snapshot.data} />);
  expect(short.indexOf('Synthetic user message')).toBeLessThan(short.indexOf('Synthetic answer'));
  expect(short).toContain('user');expect(short).toContain('assistant');
  expect(renderToStaticMarkup(<MemoryDetailsContent category="summary" data={snapshot.data} />)).toContain('A synthetic summary.');
  const facts=renderToStaticMarkup(<MemoryDetailsContent category="facts" data={snapshot.data} />);
  expect(facts).toContain('Friday');expect(facts).toContain('confirmed');expect(facts).not.toContain('source');
  expect(snapshot).toEqual(original);
});
it('defaults to the accessible Preview tab and shows every current fact without metadata',()=>{
  const data=structuredClone(snapshot.data!);
  data.facts.push({subject:'Alex',attribute:'release',value:'A long synthetic value '.repeat(30),status:'assumed',sources:['private-source'],correction:true,supersedes:[{value:'old value',status:'confirmed',sources:['old-source']}]});
  const before=structuredClone(data);
  const html=renderToStaticMarkup(<MemoryDetailsContent category="facts" data={data} />);
  expect(html).toMatch(/aria-selected="true"[^>]*>Preview/);
  for(const value of ['Project','deadline','Friday','confirmed','Alex','release','A long synthetic value','assumed'])expect(html).toContain(value);
  for(const value of ['private-source','old-source','correction','old value'])expect(html).not.toContain(value);
  expect(html).toContain('role="tabpanel"');expect(html).toContain('aria-controls=');expect(html).toContain('tabindex="0"');expect(data).toEqual(before);
});
it('renders complete raw JSON and handles empty facts in both views',()=>{
  const facts=[{subject:'Alex',attribute:'deadline',value:'Friday',status:'confirmed' as const,sources:['source-id'],correction:true,supersedes:[{value:'Monday',status:'confirmed' as const,sources:['old-id']}]}];
  const before=structuredClone(facts);
  const raw=renderToStaticMarkup(<LongTermMemoryView facts={facts} view="raw" />);
  for(const value of ['subject','attribute','deadline','Friday','status','correction','sources','source-id','supersedes','Monday','old-id'])expect(raw).toContain(value);
  expect(raw).toContain('Raw fact JSON');expect(raw).toContain('tabindex="0"');expect(facts).toEqual(before);
  expect(renderToStaticMarkup(<LongTermMemoryView facts={[]} view="preview" />)).toContain('No key facts yet.');
  expect(renderToStaticMarkup(<LongTermMemoryView facts={[]} view="raw" />)).toContain('[]');
});
