import { ChatDisclosure, chatStatusColor, chatTypeColor } from "./chat-disclosure";
import { Box, Stack, Typography } from "@mui/material";
import type { TimelineEvent } from "./week2-agent-tool-lab";
import { AnswerMarkdown } from "./answer-markdown";
import { RequestMeterCard } from "./request-meter-card";
import { toolExecutionTypeMeta } from "./tool-execution-type";

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

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
          {JSON.stringify(event.arguments, null, 2)}
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
          {JSON.stringify(
            event.error ? { error: event.error } : event.output,
            null,
            2,
          )}
        </Box>
      </Stack>
    </ChatDisclosure>
  );
}

function Activity({ event }: { event: TimelineEvent }) {
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
  | { kind: "logs"; id: string; events: TimelineEvent[] };

export function groupChatEvents(events: readonly TimelineEvent[]): ChatRow[] {
  const steps = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    if (event.kind === "message" || event.runId === "ui") continue;
    const group = steps.get(event.runId) ?? [];
    group.push(event);
    steps.set(event.runId, group);
  }
  const seen = new Set<string>();
  return events.flatMap<ChatRow>((event) => {
    if (event.kind === "message")
      return [{ kind: "message" as const, id: event.id, event }];
    if (event.runId === "ui")
      return [{ kind: "activity" as const, id: event.id, event }];
    if (seen.has(event.runId)) return [];
    seen.add(event.runId);
    return [
      {
        kind: "logs" as const,
        id: event.runId,
        events: steps.get(event.runId) ?? [],
      },
    ];
  });
}

export function logsFailed(events: readonly TimelineEvent[]) {
  return events.some(event=>event.kind==='metering'?event.meter.status==='failed':event.kind!=='message'&&event.status==='failed');
}

export function ChatRunLog({ events }: { events: readonly TimelineEvent[] }) {
  return (
    <>
      {groupChatEvents(events).map((row) => (
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
                maxWidth: { xs: "100%", md: "80%" },
                minWidth: 0,
                overflowWrap: "anywhere",
                ...(row.event.role === "user"
                  ? {
                      px: 1,
                      py: 0.6,
                      border: "1px solid",
                      borderColor: "divider",
                      borderRadius: "8px",
                      bgcolor: "action.selected",
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
            </Box>
          ) : row.kind === "activity" ? (
            <Activity event={row.event} />
          ) : (
            <ChatDisclosure
              failed={logsFailed(row.events)}
              label={
                <Typography variant="body2" color={logsFailed(row.events)?"error.main":"text.secondary"}>
                  Logs{logsFailed(row.events) ? " · Failed" : ""}
                </Typography>
              }
            >
              <Stack spacing={0.5}>
                {row.events.map((event) => (
                  <Box
                    key={event.id}
                    data-chat-step={event.id}
                    sx={{ minWidth: 0 }}
                  >
                    <Activity event={event} />
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
