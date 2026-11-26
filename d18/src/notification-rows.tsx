import { useId, type ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMore from "@mui/icons-material/ExpandMore";

export type ResourceNotification = {
  id: number;
  kind: string;
  source: string;
  receivedAt: number;
  sessionId: string | null;
  readAt: number | null;
  message?: string | null;
  content: string | null;
  status: string | null;
};
export type Subscription = {
  id: string;
  source: string;
  uri: string | null;
  status: string;
  title?: string | null;
  description?: string | null;
  scheduledAt?: string | null;
  updatedAt?: number | null;
  remoteStatus?: string;
  tools?: string[];
  chat?: string | null;
};

function Content({ value }: { value: string }) {
  let text = value;
  try {
    text = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    /* Plain text content. */
  }
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        py: 1,
        px: 1.25,
        bgcolor: "action.hover",
        borderRadius: 1,
        fontFamily: "inherit",
        typography: "body2",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        maxHeight: 180,
        overflow: "auto",
      }}
    >
      {text}
    </Box>
  );
}

function statusColor(status: string) {
  switch (status.toLowerCase()) {
    case "completed":
    case "subscribed":
      return "success.main";
    case "failed":
      return "error.main";
    case "reconnecting":
      return "warning.dark";
    case "running":
    case "subscribing":
      return "info.main";
    default:
      return "text.secondary";
  }
}

function LocalTime({ value }: { value: string | number }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
}

function CompactRow({
  title,
  source,
  time,
  status,
  statusLabel,
  unread,
  children,
}: {
  title: string;
  source: string;
  time?: ReactNode;
  status?: string | null;
  statusLabel: string;
  unread?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Accordion
      disableGutters
      elevation={0}
      square
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{
        borderBottom: 1,
        borderColor: "divider",
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary
        id={id}
        aria-controls={id + "-details"}
        expandIcon={<ExpandMore fontSize="small" />}
        sx={{
          px: 2,
          minHeight: 44,
          gap: 0.75,
          "& .MuiAccordionSummary-content": { my: 0.5, minWidth: 0 },
        }}
      >
        <Box component="span" sx={{ minWidth: 0, width: "100%" }}>
          <Box
            component="span"
            sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
          >
            {unread && (
              <Box
                component="span"
                role="img"
                aria-label="Unread"
                sx={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  bgcolor: "primary.main",
                  flexShrink: 0,
                }}
              />
            )}
            <Typography
              component="span"
              variant="body2"
              noWrap
              sx={{
                flex: 1,
                ".Mui-expanded &": {
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                },
                fontWeight: unread ? "fontWeightBold" : "fontWeightMedium",
              }}
            >
              {title}
            </Typography>
            {status && (
              <Typography
                component="span"
                variant="caption"
                noWrap
                sx={{ maxWidth: "40%", color: statusColor(status) }}
                aria-label={statusLabel + " · " + status}
              >
                {status}
              </Typography>
            )}
          </Box>
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", overflowWrap: "anywhere" }}
          >
            {source}
            {time && <> · {time}</>}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pt: 0, pb: 1 }}>
        <Stack
          spacing={0.5}
          sx={{ typography: "body2", overflowWrap: "anywhere" }}
        >
          {children}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function SubscriptionRow({
  item,
  onUnsubscribe,
}: {
  item: Subscription;
  onUnsubscribe: () => void;
}) {
  const showResourceStatus =
    item.status === "Subscribed" &&
    item.remoteStatus &&
    item.remoteStatus !== "Unknown";
  return (
    <CompactRow
      title={
        item.title?.trim() && item.title !== item.uri ? item.title : "Resource"
      }
      source={item.source}
      time={
        item.scheduledAt && (
          <>
            Scheduled <LocalTime value={item.scheduledAt} />
          </>
        )
      }
      status={showResourceStatus ? item.remoteStatus : item.status}
      statusLabel={showResourceStatus ? "Resource" : "Subscription"}
    >
      {item.description && (
        <Typography variant="body2">{item.description}</Typography>
      )}
      <span>Subscription · {item.status}</span>
      <span>Resource · {item.remoteStatus ?? "Unknown"}</span>
      {item.chat && <span>Chat · {item.chat}</span>}
      {!!item.tools?.length && <span>Tools · {item.tools.join(", ")}</span>}
      {item.uri && <span>Resource URI · {item.uri}</span>}
      <span>Subscription ID · {item.id}</span>
      {item.updatedAt != null && (
        <span>
          Last update · <LocalTime value={item.updatedAt} />
        </span>
      )}
      <Button
        size="small"
        sx={{ alignSelf: "flex-start" }}
        onClick={onUnsubscribe}
      >
        Unsubscribe
      </Button>
    </CompactRow>
  );
}

function eventTitle(n: ResourceNotification, fallback: string) {
  // Prefer a named resource. Keep unnamed payloads and their identifiers in details.
  try {
    const data = JSON.parse(n.content ?? "null");
    for (const title of [data?.title, data?.name]) {
      if (typeof title === "string" && title.trim()) return title.trim();
    }
  } catch {
    /* Plain text has no structured title. */
  }
  return n.message?.trim() || fallback;
}

export function NotificationRow({
  item,
  writing,
  onRead,
}: {
  item: ResourceNotification;
  writing: boolean;
  onRead: () => void;
}) {
  const kind =
    item.kind === "updated"
      ? "Resource updated"
      : item.kind === "reconciled"
        ? "Resource reconciled"
        : item.kind;
  return (
    <CompactRow
      title={eventTitle(item, kind)}
      source={item.source}
      time={<LocalTime value={item.receivedAt} />}
      status={item.status || "Unknown"}
      statusLabel="Resource"
      unread={item.readAt === null}
    >
      <span>{kind}</span>
      {item.message && <Typography variant="body2">{item.message}</Typography>}
      <span>Notification ID · {item.id}</span>
      {item.sessionId && <span>Chat ID · {item.sessionId}</span>}
      {item.content != null && <Content value={item.content} />}
      {item.readAt === null ? (
        <Button
          size="small"
          sx={{ alignSelf: "flex-start" }}
          disabled={writing}
          onClick={onRead}
          aria-label={`Mark notification ${item.id} as read`}
        >
          Mark as read
        </Button>
      ) : (
        <span>
          Read · <LocalTime value={item.readAt} />
        </span>
      )}
    </CompactRow>
  );
}
