import { factContextText, type MemoryData } from './session-memory';
import { estimateContextInput } from './token-meter';

export type MemoryTokenStats = {shortTermTokens:number|null;mediumTermTokens:number|null;longTermTokens:number|null;storedLongTermTokens:number|null};
type Layer = keyof MemoryTokenStats;
type Estimate = typeof estimateContextInput;
type Entry = {key:string;value:Promise<number|null>};
export type MemoryTokenCache = Partial<Record<Layer,Entry>>;

/** Count each current layer with the same local JSON estimator as context planning. */
export async function estimateMemoryTokenStats(data:MemoryData | null, model:string, cache:MemoryTokenCache = {}, estimate:Estimate = estimateContextInput):Promise<MemoryTokenStats> {
  const short=data?.short.flatMap(group=>group.messages) ?? [];
  const summary=data?.summary ?? '';
  const facts=data?.facts ?? [];
  const count=(layer:Layer,content:unknown,empty:boolean):Promise<number|null>=>{
    if(empty){delete cache[layer];return Promise.resolve(0);}
    const key=JSON.stringify([model,content]);
    if(cache[layer]?.key===key)return cache[layer]!.value;
    const value=Promise.resolve().then(()=>estimate(model,content)).then(result=>result.estimatedInputTokens ?? null).catch(()=>null);
    cache[layer]={key,value};
    // Failures may be retried on a later refresh; retain successful estimates only.
    void value.then(result=>{if(result===null && cache[layer]?.value===value)delete cache[layer];});
    return value;
  };
  const [shortTermTokens,mediumTermTokens,longTermTokens,storedLongTermTokens]=await Promise.all([
    count('shortTermTokens',short,short.length===0),
    count('mediumTermTokens',summary,summary.length===0),
    count('longTermTokens',facts.length ? factContextText(facts) : '',facts.length===0),
    count('storedLongTermTokens',facts,facts.length===0),
  ]);
  return {shortTermTokens,mediumTermTokens,longTermTokens,storedLongTermTokens};
}
