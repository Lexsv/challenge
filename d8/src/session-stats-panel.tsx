import { useEffect, useMemo, useState, type ReactNode } from "react";
import { historicalContext } from "./context-compaction";
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
}: {
  stats?: SessionStats;
  context?: NextSessionContext;
  contextPending?: boolean;
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
}) {
  const stats = useMemo(() => aggregateSessionStats(accountingState ?? state), [state, accountingState]);
  const budget = managerContextBudget(request);
  const [dialogue, setDialogue] = useState<{state: ManagerConversationState; model: string; tokens?: number}>();
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
        context={{ ...budget, dialogueTokens: pending ? undefined : dialogue?.tokens }} contextPending={pending} />
    </SessionStatsFrame>
  );
}
