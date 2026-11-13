import { useEffect, useMemo, useState, type ReactNode } from "react";
import { historicalContext } from "./context-compaction";
import { factHistory, factMessage, selectFactLayers } from './key-facts-context';
import { loadHistory, loadSessionFacts } from './session-api';
import { restoreHistory } from './conversation-history';
import { verifiedEncoding, DEFAULT_CONTEXT_ENCODING, estimateContextInput } from "./token-meter";
import { Box, Paper, Typography } from "@mui/material";
import type { ManagerConversationState } from "./manager-agent";
import {
  managerContextBudget,
  type ManagerRequestConfig,
} from "./manager-llm-adapter";
import type { ToolRegistry } from "./tool-runtime";
import {
  aggregateSessionStats,
  type NextSessionContext,
  type SessionStats,
} from "./session-stats";

export const sessionChatColumns = {
  xs: "minmax(0, 1fr)",
  lg: "minmax(0, 1fr) 430px",
};
export const formatSessionCost = (cost: number) =>
  `$${cost.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;

const number = (value: number) => value.toLocaleString("en-US");
const duration = (ms: number) =>
  ms < 60000
    ? `${number(Math.round(ms / 100) / 10)} s`
    : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;

export type ContextBreakdown = {dialogue:number; facts:number; buffer:number; recent:number; bufferCount:number; window:number};
export async function estimateContextBreakdown(state: ManagerConversationState, saved: Awaited<ReturnType<typeof loadSessionFacts>>, window: number, model: string): Promise<ContextBreakdown> {
  const history = factHistory(state);
  const layers = selectFactLayers(history, saved.coveredMessageId, window);
  const estimate = async (messages: ReturnType<typeof factMessage>) => messages.length ? (await estimateContextInput(model, messages)).estimatedInputTokens : 0;
  const [dialogue,facts,buffer,recent] = await Promise.all([
    estimate(history.flatMap(group=>group.messages)), estimate(factMessage(saved.facts)),
    estimate(layers.buffer.flatMap(group=>group.messages)), estimate(layers.recent.flatMap(group=>group.messages)),
  ]);
  if ([dialogue,facts,buffer,recent].some(value=>value===undefined)) throw new Error('Token estimate unavailable.');
  return {dialogue:dialogue!,facts:facts!,buffer:buffer!,recent:recent!,bufferCount:layers.buffer.length,window};
}

export function ContextBreakdownPanel({value}: {value?: ContextBreakdown}) {
  const ratio = value ? value.bufferCount / value.window : 0;
  const color = ratio >= 1 ? '#c54c4c' : ratio >= .7 ? '#cf9b2d' : '#4d9a79';
  const status = ratio >= 1 ? 'Full' : ratio >= .7 ? 'Near threshold' : 'Below threshold';
  const compression = value && value.dialogue > 0 && value.facts > 0 ? Math.round(value.facts/value.dialogue*100) : undefined;
  const rows = [ ['Dialogue',value?.dialogue,'#65858e'], ['Fact context',value?.facts,'#5d9b9d'], ['Buffer',value?.buffer,color], ['Compression',compression,'#5d9b9d'] ] as const;
  return <Box component="section" aria-label="Context breakdown" sx={{gridColumn:'1 / -1',borderTop:1,borderColor:'divider',pt:1,mt:.25}}>
    {rows.map(([label,tokens,fill])=><Box key={label} sx={{mt:1}}>
      <Box sx={{display:'flex',justifyContent:'space-between',gap:1,fontSize:14,fontVariantNumeric:'tabular-nums'}}><span>{label}</span><span>{tokens===undefined?'—':label==='Compression'?`${tokens}%`:`≈${number(tokens)}`}</span></Box>
      <Box aria-hidden="true" sx={{height:7,bgcolor:'#edf5f5',borderRadius:2,mt:.5,overflow:'hidden'}}>
        <Box sx={{height:'100%',borderRadius:2,bgcolor:fill,width:`${label==='Buffer' ? Math.min(100,ratio*100) : label==='Compression' ? Math.max(0,Math.min(100,compression ?? 0)) : value && value.dialogue>0 && tokens!==undefined ? Math.min(100,tokens/value.dialogue*100) : 0}%`,transition:'width 300ms ease, background-color 300ms ease','@media (prefers-reduced-motion: reduce)':{transition:'none'}}} />
      </Box>
      {label==='Buffer' && <Box sx={{display:'flex',justifyContent:'space-between',gap:1,color:'text.secondary',fontSize:12,mt:.5}}><span>{value?`${value.bufferCount} / ${value.window} messages`:'Updating…'}</span><span>{value?status:''}</span></Box>}
    </Box>)}
  </Box>;
}

export function SessionStatsFrame({ children }: { children: ReactNode }) {
  return (
    <Paper
      component="aside"
      variant="outlined"
      aria-label="Session stats"
      sx={{ p: 1.5, minWidth: 0, maxWidth: "100%" }}
    >
      <Typography variant="h6" component="h3" sx={{ mb: 1.5, fontWeight: 700 }}>
        Session stats
      </Typography>
      {children}
    </Paper>
  );
}

export function SessionStatsContent({
  stats,
  context,
  contextPending = false,
  breakdown,
  showBreakdown = false,
}: {
  stats?: SessionStats;
  context?: NextSessionContext;
  contextPending?: boolean;
  breakdown?: ContextBreakdown;
  showBreakdown?: boolean;
}) {
  const usage = (value: SessionStats["input"] | undefined) =>
    value?.reportedRequests ? number(value.knownTokens) : "Not reported";
  const rows: [string, ReactNode][] = [
    [
      "Models used",
      stats?.models.length
        ? [...new Set(stats.models.map((model) => model.model))].map(
            (model) => <Box key={model}>{model}</Box>,
          )
        : "—",
    ],
    ["Requests", number(stats?.requestCount ?? 0)],
    ["Tokens", ""],
    ["Input", usage(stats?.input)],
    ["Output", usage(stats?.output)],
    [
      "Total",
      stats?.total.reportedValues
        ? number(stats.total.knownTokens)
        : "Not reported",
    ],
    [
      "Active time",
      `${duration(stats?.activeTime.milliseconds ?? 0)}${stats?.activeTime.missingDurations ? " · Partial" : ""}`,
    ],
    [
      "Cost (≈)",
      stats?.cost.subtotals.length ? (
        <>
          {stats.cost.subtotals.map((cost) => (
            <Box key={cost.currency}>
              {formatSessionCost(cost.subtotal)} {cost.currency}
            </Box>
          ))}
        </>
      ) : (
        "Unavailable"
      ),
    ],
  ];
  rows.push(
    ["Context", ""],
    ["Model window", context?.contextWindow === undefined ? "Unavailable" : number(context.contextWindow)],
    ["Dialogue", context?.dialogueTokens === undefined ? (contextPending ? "Updating…" : "Unavailable") : number(context.dialogueTokens)],
    ["Compaction target", context?.requestTokenLimit === undefined ? "Unavailable" : context.requestTokenLimit === 0 ? (context.contextWindow === undefined ? "Auto" : `${number(context.contextWindow)} (Auto)`) : number(context.requestTokenLimit)],
    ["Last request", stats?.lastAnswer
      ? (stats.lastAnswer.sentInputTokens ?? stats.lastAnswer.estimatedInputTokens) !== undefined
        ? `≈${number((stats.lastAnswer.sentInputTokens ?? stats.lastAnswer.estimatedInputTokens)!)}` : "Unavailable"
      : "—"],
  );
  if (showBreakdown) rows.push(['Recent messages', breakdown?.recent === undefined ? '—' : `≈${number(breakdown.recent)}`]);
  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        columnGap: 1,
        rowGap: 1.25,
        m: 0,
      }}
    >
      {rows.map(([label, value]) => (label === "Context" || label === "Tokens") ? (
        <Typography key={label} component="dt" variant="body2" sx={{ gridColumn: "1 / -1", textAlign: "center", fontWeight: 700, pt: 2.5 }}>{label}</Typography>
      ) : (
        <Box key={label} sx={{ display: "contents" }}>
          <Typography
            component="dt"
            variant="body2"
            sx={{
              fontWeight: 700,
              whiteSpace: { lg: "nowrap" },
              minWidth: 0,
              pt: [
                "Active time",
                "Context",
              ].includes(label)
                ? 2.5
                : 0,
            }}
          >
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body2"
            sx={{
              m: 0,
              minWidth: 0,
              textAlign: "right",
              fontWeight: 400,
              overflowWrap: "anywhere",
              whiteSpace: { lg: "nowrap" },
              pt: [
                "Active time",
                "Context",
              ].includes(label)
                ? 2.5
                : 0,
            }}
          >
            {value}
          </Typography>
        </Box>
      ))}
      {showBreakdown && <ContextBreakdownPanel value={breakdown}/>}
    </Box>
  );
}

export function SessionStatsPanel({
  state,
  draft,
  request,
  tools,
  active,
  loaded,
  running,
  accountingState,
  dialogueCounts,
  contextStrategy,
  recentMessages,
  factsRevision,
}: {
  state: ManagerConversationState;
  draft: string;
  request: ManagerRequestConfig;
  tools: ToolRegistry;
  active: boolean;
  loaded: boolean;
  running: boolean;
  accountingState?: ManagerConversationState;
  dialogueCounts?: Partial<Record<'o200k_base' | 'cl100k_base',number>>;
  contextStrategy?: 'token-budget'|'key-facts';
  recentMessages?: number;
  factsRevision?: number;
}) {
  const stats = useMemo(() => aggregateSessionStats(accountingState ?? state), [state, accountingState]);
  const budget = managerContextBudget(request);
  const [dialogue, setDialogue] = useState<{state: ManagerConversationState; model: string; tokens?: number}>();
  const [breakdown, setBreakdown] = useState<ContextBreakdown>();
  useEffect(() => {
    let current=true;
    if (!active || !loaded || contextStrategy !== 'key-facts') { setBreakdown(undefined); return; }
    void Promise.all([loadHistory(state.conversation.id), loadSessionFacts(state.conversation.id)])
      .then(([events,saved])=>estimateContextBreakdown(restoreHistory(state,events),saved,recentMessages ?? 10,request.model))
      .then(value=>{if(current)setBreakdown(value);}).catch(()=>{if(current)setBreakdown(undefined);});
    return ()=>{current=false;};
  },[active,loaded,contextStrategy,recentMessages,state,request.model,factsRevision]);
  useEffect(() => {
    let current = true;
    if (!active || !loaded) return;
    if(dialogueCounts){
      setDialogue({state,model:request.model,tokens:dialogueCounts[verifiedEncoding(request.model) ?? DEFAULT_CONTEXT_ENCODING]});
      return;
    }
    const messages = historicalContext({ ...state, contextEvents: [] }, '__session-dialogue__').filter(m => m.role !== 'system');
    void (messages.length ? estimateContextInput(request.model, messages).then(r => r.estimatedInputTokens) : Promise.resolve(0))
      .then(tokens => { if (current) setDialogue({state, model: request.model, tokens}); });
    return () => { current = false; };
  }, [state, request.model, active, loaded, dialogueCounts]);
  const pending = dialogue?.state !== state || dialogue?.model !== request.model;
  return (
    <SessionStatsFrame>
      <SessionStatsContent stats={loaded ? stats : undefined}
        context={{ ...budget, dialogueTokens: pending ? undefined : dialogue?.tokens }} contextPending={pending}
        showBreakdown={contextStrategy==='key-facts'} breakdown={breakdown} />
    </SessionStatsFrame>
  );
}
