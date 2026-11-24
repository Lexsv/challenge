import {compactToolLabel,journalStatus,journalStatusStyle,type JournalRow} from "./session-tool-journal";
import { ChatDisclosure, chatStatusColor, chatTypeColor } from "./chat-disclosure";
import ShieldOutlined from "@mui/icons-material/ShieldOutlined";
import type {SecurityEvent} from "./chat-invariants";
import { Box, Stack, Typography } from "@mui/material";
import type { TimelineEvent } from "./week2-agent-tool-lab";
import { AnswerMarkdown } from "./answer-markdown";
import { RequestMeterCard } from "./request-meter-card";
import { toolExecutionTypeMeta } from "./tool-execution-type";

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

const marker = "████████";

const localTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const localDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium" });

function MessageTime({ at, align }: { at: number; align: "left" | "right" }) {
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return <Typography component="time" variant="caption" color="text.secondary"
    dateTime={date.toISOString()} title={localDateTime.format(date)} align={align}
    sx={{ display: "block", mt: 0.5, lineHeight: 1.25 }}>
    {localTime.format(date)}
  </Typography>;
}

function redactionExplanation(event: TimelineEvent) {
  if (event.kind === "tool") {
    const visible = JSON.stringify([event.arguments, event.error || event.output]);
    if (visible.includes(marker)) return "A session rule hides marked tool data.";
  }
  if (event.kind !== "message" || event.role !== "assistant" || !event.text.includes(marker)) return;
  // A withheld answer can retain punctuation around one or more markers.
  return /[\p{L}\p{N}]/u.test(event.text.replaceAll(marker, ""))
    ? "A session rule hides the marked parts of this response."
    : "A session rule hides this entire response.";
}

function RedactionNotice({ explanation }: { explanation: string }) {
  return (
    <Typography component="div" variant="body2" sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "warning.dark" }}>
      <ShieldOutlined aria-hidden="true" sx={{ fontSize: 16, flexShrink: 0 }} />
      {explanation}
    </Typography>
  );
}

function SecurityLog({event}:{event:SecurityEvent}) {
  const label={blocked:"Request blocked",redacted:"Response redacted",withheld:"Response withheld"}[event.action];
  return <ChatDisclosure label={<Typography component="span" variant="body2" sx={{display:"flex",gap:.5,alignItems:"center",color:"warning.dark"}}><ShieldOutlined fontSize="small"/>SECURITY · {label}</Typography>}>
    <Typography variant="body2">The {event.stage==="input"?"requested operation":"generated content"} conflicted with an enabled session invariant.</Typography>
    <Typography component="div" variant="caption" sx={{overflowWrap:"anywhere"}}>
      Stage: {event.stage} · Action: {event.action} · {new Date(event.timestamp).toISOString()}<br/>
      Invariant: {event.invariantId}<br/>Session: {event.sessionId}<br/>Turn: {event.turnId}
    </Typography>
  </ChatDisclosure>;
}
function BlockedRequestLog() {
  return <Stack spacing={0.5}>
    <Typography variant="body2" sx={{ display: "flex", alignItems: "center", gap: 0.5, color: "warning.dark" }}>
      <ShieldOutlined aria-hidden="true" fontSize="small" />SECURITY · Request blocked
    </Typography>
    <Typography variant="body2">This request was blocked because it violates a content rule for this chat.</Typography>
  </Stack>;
}
function toolText(value:unknown) {
  const text = JSON.stringify(value, null, 2);
  if (!text?.includes(marker)) return text;
  return text.split(/(████████)/u).map((part,index)=>part===marker
    ? <span key={index} role="img" aria-label="Redacted content" style={{backgroundColor:'black',color:'black'}}>{marker}</span> : part);
}

function ToolStep({
  event,
}: {
  event: Extract<TimelineEvent, { kind: "tool" }>;
}) {
  const meta = event.executionType
    ? toolExecutionTypeMeta[event.executionType]
    : undefined;
  return (
    <ChatDisclosure
      label={
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          flexWrap="wrap"
          alignItems="baseline"
        >
          <Typography variant="body2" component="span" color="text.primary">
            <Box
              component="span"
              sx={{ color: event.executionType && event.executionType in chatTypeColor
                ? chatTypeColor[event.executionType as keyof typeof chatTypeColor]
                : meta?.color ?? "text.secondary" }}
            >
              {meta?.label ?? "Tool"}
            </Box>{" "}
            · {event.toolName}
          </Typography>
          <Typography
            variant="body2"
            component="span"
            color={chatStatusColor(event.status)}
          >
            {titleCase(event.status)}
          </Typography>
        </Stack>
      }
    >
      <Stack spacing={0.75} sx={{ overflowWrap: "anywhere", minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary">
          Tool ID: {event.toolId}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Duration: {event.durationMs} ms
        </Typography>
        <Typography variant="subtitle2">Arguments</Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: ".76rem",
          }}
        >
          {toolText(event.arguments)}
        </Box>
        <Typography variant="subtitle2">Result</Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: ".76rem",
          }}
        >
          {toolText(event.error ? {error:event.error}:event.output)}
        </Box>

      </Stack>
    </ChatDisclosure>
  );
}

function Activity({ event,journal }: { event: TimelineEvent; journal?:Map<string,JournalRow> }) {
  if(journal && event.kind==="manager" && event.id===event.runId+":end"){
    const call=[...journal.values()].find(r=>r.runId===event.runId);
    if(call)return <Typography variant="body2">Manager | {call.runState}</Typography>;
  }
  if(journal && event.kind==="tool"){
    const row=journal.get(event.id);
    return <Typography variant="body2" sx={{overflowWrap:"anywhere", color:row ? journalStatusStyle(journalStatus(row)).color : "text.secondary"}}>{row?compactToolLabel(row):[event.executionType??"Tool",event.toolName,event.status].join(" | ")}</Typography>;
  }
  if (event.kind === "metering")
    return <RequestMeterCard meter={event.meter} presentation="chat" />;
  if (event.kind === "tool") return <ToolStep event={event} />;
  if (event.kind === "manager")
    return (
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        flexWrap="wrap"
        alignItems="baseline"
        sx={{ py: 0.4 }}
      >
        <Typography
          variant="body2"
          component="span"
          color={event.category === "SYSTEM" ? "warning.main" : chatTypeColor.manager}
        >
          {titleCase(event.category)}
        </Typography>
        <Typography
          variant="body2"
          component="span"
          color="text.primary"
          sx={{ overflowWrap: "anywhere" }}
        >
          {event.description}
        </Typography>
        <Typography
          variant="body2"
          component="span"
          color={chatStatusColor(event.status)}
        >
          {titleCase(event.status)}
        </Typography>
      </Stack>
    );
  return null;
}

// Presentation grouping only: the event array and the Timeline builder stay untouched.
type ChatRow =
  | {
      kind: "message";
      id: string;
      event: Extract<TimelineEvent, { kind: "message" }>;
    }
  | { kind: "activity"; id: string; event: TimelineEvent }
  | { kind: "logs"; id: string; createdAt: number; events: TimelineEvent[]; blocked?: boolean };

export function groupChatEvents(events: readonly TimelineEvent[], securityRuns = new Set<string>()): ChatRow[] {
  const steps = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    if (event.kind === "message" || event.runId === "ui") continue;
    const group = steps.get(event.runId) ?? [];
    group.push(event);
    steps.set(event.runId, group);
  }
  const seen = new Set<string>();
  return events.flatMap<ChatRow>((event) => {
    if (event.kind === "message") {
      const message: ChatRow = { kind: "message", id: event.id, event };
      if (event.role === "user" && event.blocked) {
        return [message, { kind: "logs", id: event.runId, createdAt: event.createdAt, events: [], blocked: true }];
      }
      if (event.role === "assistant" && securityRuns.has(event.runId) && !steps.has(event.runId) && !seen.has(event.runId)) {
        seen.add(event.runId);
        return [{ kind: "logs", id: event.runId, createdAt: event.createdAt, events: [] }, message];
      }
      return [message];
    }
    if (event.runId === "ui")
      return [{ kind: "activity" as const, id: event.id, event }];
    if (seen.has(event.runId)) return [];
    seen.add(event.runId);
    return [
      {
        kind: "logs" as const,
        id: event.runId,
        createdAt: event.createdAt,
        events: steps.get(event.runId) ?? [],
      },
    ];
  });
}

export function logsFailed(events: readonly TimelineEvent[], journal?: ReadonlyMap<string, JournalRow>) {
  return events.some(event => {
    // Older history collapsed every unsuccessful proposal into "failed".
    const receipt = event.kind === "tool" && journal?.get(event.id);
    if (receipt) return receipt.status === "Failed";
    return event.kind==='metering'?event.meter.status==='failed':event.kind!=='message'&&event.status==='failed';
  });
}

export function ChatRunLog({ events, security = [], week3 = false,journal }: {
  journal?:readonly JournalRow[];
  events: readonly TimelineEvent[];
  security?: readonly SecurityEvent[];
  week3?: boolean;
}) {
  const calls=journal && new Map(journal.map(r=>[r.id,r]));
  const explanations = new Map<string, Set<string>>();
  const securityRuns = new Set(security.map(event => event.turnId));
  for (const event of events) {
    const explanation = redactionExplanation(event);
    if (!explanation) continue;
    const notices = explanations.get(event.runId) ?? new Set<string>();
    notices.add(explanation);
    explanations.set(event.runId, notices);
    securityRuns.add(event.runId);
  }
  // A later model failure can leave a durable tool receipt without a committed
  // chat event. Join on the logical call ID and keep it with its original run.
  let visibleEvents=events;
  if(journal){
    const known=new Set(events.map(e=>e.id));
    const oldest=events[0]?.createdAt??0;
    const retained:TimelineEvent[]=journal.filter(r=>!known.has(r.id) && r.created>=oldest).map(r=>({
      kind:"tool",id:r.id,runId:r.runId,createdAt:r.created,category:"TOOL",toolId:r.toolId,toolName:r.name,
      status:r.status==="Success"?"completed":r.status==="Running"?"running":r.status==="Pending"?"pending":
        r.status==="Skipped"?"skipped":r.status==="Unknown"?"unknown":r.status==="Failed"?"failed":"incomplete",
      arguments:undefined,durationMs:r.duration
    }));
    if(retained.length)visibleEvents=[...events,...retained].sort((a,b)=>a.createdAt-b.createdAt);
  }
  const rows = groupChatEvents(visibleEvents, securityRuns);
  const runs = new Set(rows.filter(row => row.kind === "logs").map(row => row.id));
  // Legacy audit-only blocks have no saved question. Place those by timestamp.
  // New blocks follow their message, including when older pages are loaded.
  for (const event of security) {
    if (event.recordedQuestion || runs.has(event.turnId)) continue;
    const index = rows.findIndex(row =>
      (row.kind === "logs" ? row.createdAt : row.event.createdAt) > event.timestamp);
    rows.splice(index < 0 ? rows.length : index, 0, {
      kind: "logs", id: event.turnId, createdAt: event.timestamp, events: [], blocked: event.action === "blocked",
    });
  }
  return (
    <>
      {rows.map((row) => (
        <Box
          key={`${row.kind}:${row.id}`}
          sx={{
            width: "100%",
            minWidth: 0,
            alignSelf: "flex-start",
            textAlign: "left",
            color: "text.primary",
          }}
        >
          {row.kind === "message" ? (
            <Box
              sx={{
                width: "fit-content",
                maxWidth: week3 && row.event.role !== "system" ? "85%" : { xs: "100%", md: "80%" },
                minWidth: 0,
                overflowWrap: "anywhere",
                ...(row.event.role === "user" || (week3 && row.event.role === "assistant")
                  ? {
                      boxSizing: "border-box",
                      ml: week3 && row.event.role === "user" ? "auto" : 0,
                      px: week3 ? 1.5 : 1,
                      py: week3 ? 1 : 0.6,
                      border: "1px solid",
                      borderColor: "divider",
                      borderRadius: "8px",
                      bgcolor: row.event.role === "user" ? "action.selected" : "background.paper",
                      color: "text.primary",
                    }
                  : {}),
                "& p": { m: 0 },
                "& h4, & h5, & h6": { color: "text.primary" },
                "& pre": { overflowX: "auto" },
              }}
            >
              {row.event.role === "system" && (
                <Typography variant="caption" color="warning.main">
                  System
                </Typography>
              )}
              {row.event.role === "assistant" ? (
                <AnswerMarkdown text={row.event.text} />
              ) : (
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {row.event.text}
                </Typography>
              )}
              {week3 && row.event.role !== "system" && (
                <MessageTime at={row.event.createdAt} align={row.event.role === "user" ? "right" : "left"} />
              )}
            </Box>
          ) : row.kind === "activity" ? (
            row.event.kind === "tool" && redactionExplanation(row.event) ? (
              <ChatDisclosure label="Logs · Security">
                <RedactionNotice explanation="A session rule hides marked tool data." />
                <Activity journal={calls} event={row.event} />
              </ChatDisclosure>
            ) : <Activity journal={calls} event={row.event} />
          ) : (
            <ChatDisclosure
              failed={logsFailed(row.events,calls)}
              label={
                <Typography variant="body2" color={logsFailed(row.events,calls)?"error.main":"text.secondary"}>
                  {row.blocked || securityRuns.has(row.id) ? "Logs · Security" : logsFailed(row.events,calls) ? "Logs · Failed" : "Logs"}
                </Typography>
              }
            >
              <Stack spacing={0.5}>
                {Array.from(explanations.get(row.id) ?? [], explanation => <RedactionNotice key={explanation} explanation={explanation} />)}
                {row.blocked ? <BlockedRequestLog /> : security.filter(e=>e.turnId===row.id).map(e=><SecurityLog key={e.turnId} event={e}/>)}
                {row.events.map((event) => (
                  <Box
                    key={event.id}
                    data-chat-step={event.id}
                    sx={{ minWidth: 0 }}
                  >
                    <Activity journal={calls} event={event} />
                  </Box>
                ))}
              </Stack>
            </ChatDisclosure>
          )}
        </Box>
      ))}
    </>
  );
}
