import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { historicalContext } from "./context-compaction";
import { factHistory, factMessage, selectFactLayers } from './key-facts-context';
import { loadHistory, loadSessionFacts } from './session-api';
import { restoreHistory } from './conversation-history';
import { verifiedEncoding, DEFAULT_CONTEXT_ENCODING, estimateContextInput } from "./token-meter";
import ExpandMore from "@mui/icons-material/ExpandMore";
import { Accordion, AccordionDetails, AccordionSummary, Box, Paper, Typography } from "@mui/material";
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
  const color = ratio >= 1 ? 'error.main' : ratio >= .7 ? 'warning.main' : 'success.main';
  const status = ratio >= 1 ? 'Full' : ratio >= .7 ? 'Near threshold' : 'Below threshold';
  const compression = value && value.dialogue > 0 && value.facts > 0 ? Math.round(value.facts/value.dialogue*100) : undefined;
  const rows = [ ['Dialogue',value?.dialogue,'primary.main'], ['Fact context',value?.facts,'info.main'], ['Buffer',value?.buffer,color], ['Compression',compression,'info.main'] ] as const;
  return <Box component="section" aria-label="Context breakdown" sx={{gridColumn:'1 / -1',borderTop:1,borderColor:'divider',pt:1,mt:.25}}>
    {rows.map(([label,tokens,fill])=><Box key={label} sx={{mt:1}}>
      <Box sx={{display:'flex',justifyContent:'space-between',gap:1,fontSize:14,fontVariantNumeric:'tabular-nums'}}><span>{label}</span><span>{tokens===undefined?'—':label==='Compression'?`${tokens}%`:`≈${number(tokens)}`}</span></Box>
      <Box aria-hidden="true" sx={{height:7,bgcolor:'secondary.light',borderRadius:2,mt:.5,overflow:'hidden'}}>
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

type StatRow = [string, ReactNode];
type SecurityCounts = Record<"blocked" | "redacted" | "withheld", number>;
type CompactStats = { model?: string; security?: SecurityCounts };

function StatSection({ title, summary, rows, children }: {
  title: string; summary: string; rows: StatRow[]; children?: ReactNode;
}) {
  const id = useId();
  return <Accordion defaultExpanded={title === "Tokens"} disableGutters elevation={0}
    sx={{ borderTop: 1, borderColor: "divider", "&::before": { display: "none" } }}>
    <AccordionSummary id={id} aria-controls={id+"-content"} expandIcon={<ExpandMore fontSize="small" />}
      sx={{ px: 0, minHeight: 40, "& .MuiAccordionSummary-content": { alignItems: "baseline", flexWrap: "wrap", gap: .5, mr: 1, my: 1 } }}>
      <Typography component="span" variant="subtitle2" sx={{ flexGrow: 1 }}>{title}</Typography>
      <Typography component="span" variant="caption" color="text.secondary">{summary}</Typography>
    </AccordionSummary>
    <AccordionDetails sx={{ px: 0, pt: 0, pb: 1.25 }}>
      <Box component="dl" sx={{ m: 0, px: 1.25, py: 1, borderRadius: 1, bgcolor: "action.hover", display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", columnGap: 1, rowGap: .5, overflowWrap: "anywhere" }}>
        {rows.map(([label,value])=><Box key={label} sx={{ display: "contents" }}>
          <Typography component="dt" variant="body2" color="text.secondary">{label}</Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
        </Box>)}
      </Box>
      {children}
    </AccordionDetails>
  </Accordion>;
}

export function SessionStatsContent({
  stats,
  context,
  contextPending = false,
  breakdown,
  showBreakdown = false,
  fullContext = false,
  compact,
}: {
  stats?: SessionStats;
  context?: NextSessionContext;
  contextPending?: boolean;
  breakdown?: ContextBreakdown;
  showBreakdown?: boolean;
  fullContext?: boolean;
  compact?: CompactStats;
}) {
  const usage = (value: SessionStats["input"] | undefined) =>
    value?.reportedRequests ? number(value.knownTokens) : "Not reported";
  const modelsUsed: StatRow = [
      "Models used",
      stats?.models.length
        ? [...new Set(stats.models.map((model) => model.model))].map(
            (model) => <Box key={model}>{model}</Box>,
          )
        : "—",
    ];
  const tokens: StatRow[] = [
    ["Input", usage(stats?.input)],
    ["Output", usage(stats?.output)],
    [
      "Total",
      stats?.total.reportedValues
        ? number(stats.total.knownTokens)
        : "Not reported",
    ],
  ];
  const requests: StatRow = ["Requests", compact && !stats ? "Unavailable" : number(stats?.requestCount ?? 0)];
  const usageRows: StatRow[] = [
    [
      "Active time",
      compact && !stats ? "Unavailable" : `${duration(stats?.activeTime.milliseconds ?? 0)}${stats?.activeTime.missingDurations ? " · Partial" : ""}`,
    ],
    [
      compact ? "Estimated cost" : "Cost (≈)",
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
  const contextRows: StatRow[] = [
    ["Model window", context?.contextWindow === undefined ? "Unavailable" : number(context.contextWindow)],
    ["Dialogue", context?.dialogueTokens === undefined ? (contextPending ? "Updating…" : "Unavailable") : number(context.dialogueTokens)],
    ["Last request", stats?.lastAnswer
      ? (stats.lastAnswer.sentInputTokens ?? stats.lastAnswer.estimatedInputTokens) !== undefined
        ? `≈${number((stats.lastAnswer.sentInputTokens ?? stats.lastAnswer.estimatedInputTokens)!)}` : "Unavailable"
      : "—"],
  ];
  if (!fullContext) contextRows.splice(contextRows.length - 1, 0, ["Compaction target", context?.requestTokenLimit === undefined ? "Unavailable" : context.requestTokenLimit === 0 ? (context.contextWindow === undefined ? "Auto" : `${number(context.contextWindow)} (Auto)`) : number(context.requestTokenLimit)]);
  if (showBreakdown) contextRows.push(['Recent messages', breakdown?.recent === undefined ? '—' : `≈${number(breakdown.recent)}`]);
  if (compact) {
    const counts = compact.security;
    const securityRows: StatRow[] = (["blocked","redacted","withheld"] as const).map(key =>
      [key[0].toUpperCase()+key.slice(1), counts ? number(counts[key]) : "Unavailable"]);
    const total = stats?.total;
    return <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" component="div" color="text.secondary">Selected model</Typography>
      <Typography variant="subtitle2" sx={{ mb: 1.25, overflowWrap: "anywhere" }}>{compact.model || "Unavailable"}</Typography>
      <StatSection title="Tokens" summary={total?.reportedValues ? number(total.knownTokens)+" reported" : "Not reported"} rows={tokens}/>
      <StatSection title="Context" summary={context?.contextWindow === undefined ? "Window unavailable" : number(context.contextWindow)+" window"} rows={contextRows}>
        {showBreakdown && <ContextBreakdownPanel value={breakdown}/>}
      </StatSection>
      <StatSection title="Security" summary={counts ? number(counts.blocked)+" blocked · "+number(counts.redacted)+" redacted · "+number(counts.withheld)+" withheld" : "Counts unavailable"} rows={securityRows}/>
      <StatSection title="Usage" summary={stats ? number(stats.requestCount)+(stats.requestCount===1?" request":" requests") : "Requests unavailable"} rows={[requests,...usageRows,modelsUsed]}/>
    </Box>;
  }
  const rows: StatRow[] = [modelsUsed, requests, ["Tokens",""], ...tokens, ...usageRows, ["Context",""], ...contextRows];
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
  fullContext,
  compact,
  children,
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
  fullContext?: boolean;
  compact?: CompactStats;
  children?: ReactNode;
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
      <SessionStatsContent compact={compact} stats={loaded ? stats : undefined}
        context={{ ...budget, dialogueTokens: pending ? undefined : dialogue?.tokens }} contextPending={pending}
        showBreakdown={contextStrategy==='key-facts'} breakdown={breakdown} fullContext={fullContext} />
      {children}
    </SessionStatsFrame>
  );
}
