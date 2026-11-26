import { Box, Stack, Tooltip } from "@mui/material";
import Stream from "@mui/icons-material/Stream";
import Sensors from "@mui/icons-material/Sensors";
import SensorsOff from "@mui/icons-material/SensorsOff";
import Link from "@mui/icons-material/Link";
import LinkOff from "@mui/icons-material/LinkOff";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import type { McpConnection, McpTool } from "./mcp-connections";

export function AsyncEvents({
  connection: c,
  tool,
}: {
  connection: McpConnection;
  tool?: McpTool;
}) {
  const subscription = c.capabilities?.subscribe;
  const links = tool ? tool.resourceLinksObserved : Boolean(c.linkToolCount);
  const watching = tool
    ? tool.watchAttachedChats
    : c.watchToolCount === undefined
      ? undefined
      : c.watchToolCount > 0;
  const transport =
    c.transport === "sse" ? "Legacy HTTP + SSE" : "Streamable HTTP";
  const stream = c.sseActive
    ? "SSE stream open"
    : c.sseActive === false
      ? "no open SSE stream"
      : "live SSE state unknown";
  const observation =
    c.sseObserved === true
      ? "SSE previously observed"
      : c.sseObserved === false
        ? "standalone SSE GET returned 405"
        : "SSE availability unverified";
  const facts = [
    {
      Icon: Stream,
      color:
        c.error === "transport"
          ? "error.main"
          : c.sseActive
            ? "success.main"
            : c.sseActive === false && c.sseObserved != null
              ? "text.secondary"
              : "warning.main",
      title:
        transport +
        " · " +
        stream +
        " · " +
        observation +
        (c.error === "transport"
          ? " · last discovery failed at transport"
          : ""),
    },
    {
      Icon: subscription === false ? SensorsOff : Sensors,
      color: c.resourceError
        ? "error.main"
        : subscription == null
          ? "warning.main"
          : subscription
            ? "success.main"
            : "text.secondary",
      title:
        "Resource subscriptions · " +
        (subscription == null
          ? "capability unknown"
          : subscription
            ? "server advertised support"
            : "server did not advertise support") +
        (c.resourceError
          ? " · resource discovery failed (" + c.resourceError + ")"
          : ""),
    },
    {
      Icon: links ? Link : LinkOff,
      color: links ? "success.main" : "warning.main",
      title:
        "Resource links · " +
        (links
          ? tool
            ? "typed link observed from this tool"
            : "typed links observed from " + c.linkToolCount + " tool(s)"
          : "no validated typed link observed for this revision"),
    },
    {
      Icon: watching === false ? VisibilityOff : Visibility,
      color:
        watching == null
          ? "warning.main"
          : watching
            ? "success.main"
            : "text.secondary",
      title:
        "Automatic Resource Watching · " +
        (watching == null
          ? "saved setting unknown"
          : watching
            ? tool
              ? "enabled for attached chats"
              : "enabled for " + c.watchToolCount + " tool(s) in attached chats"
            : "disabled for attached chats") +
        (tool && !watching && tool.watchEnabled
          ? " · a separate scoped watch grant exists"
          : ""),
    },
  ];
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      aria-label="Async Events"
    >
      {facts.map(({ Icon, color, title }) => (
        <Tooltip title={title} key={title}>
          <Box
            component="span"
            role="img"
            tabIndex={0}
            aria-label={title}
            sx={{ display: "inline-flex", color }}
          >
            <Icon sx={{ fontSize: 18 }} />
          </Box>
        </Tooltip>
      ))}
    </Stack>
  );
}
