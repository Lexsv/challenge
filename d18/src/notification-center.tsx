import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import NotificationsNone from "@mui/icons-material/NotificationsNone";
import Close from "@mui/icons-material/Close";
import {
  NotificationRow,
  SubscriptionRow,
  type ResourceNotification,
  type Subscription,
} from "./notification-rows";

type Counts = { unread: number; through: number };
type Page = Counts & {
  items: ResourceNotification[];
  next: string | null;
  subscriptions?: Subscription[];
};
const channelName = "day18-notifications";

export function refreshResourceNotifications() {
  window.dispatchEvent(new Event(channelName));
  try {
    localStorage.setItem(channelName, crypto.randomUUID());
  } catch {
    /* Polling remains available. */
  }
}

async function request<T>(
  path: string,
  method: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/notifications" + path, {
    method,
    signal,
    cache: "no-store",
    headers: { "X-Day18-UI": "notifications" },
  });
  if (!response.ok) throw Error("Notification request failed.");
  return response.json() as Promise<T>;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Subscription | null>(null);
  const [counts, setCounts] = useState<Counts>({ unread: 0, through: 0 });
  const [page, setPage] = useState<Page | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [error, setError] = useState(""),
    [writing, setWriting] = useState(false);
  const [revision, invalidate] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const broadcast =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(channelName)
        : null;
    channel.current = broadcast;
    const updated = () => invalidate((r) => r + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === channelName) updated();
    };
    if (broadcast) broadcast.onmessage = updated;
    window.addEventListener("storage", storage);
    window.addEventListener(channelName, updated);
    return () => {
      broadcast?.close();
      channel.current = null;
      window.removeEventListener("storage", storage);
      window.removeEventListener(channelName, updated);
    };
  }, []);
  // One poller for the shared header. Hidden tabs cancel in-flight reads and
  // obtain a fresh snapshot on return. Changing pages or opening refreshes now.
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>,
      controller: AbortController | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      controller?.abort();
      if (!active || document.visibilityState === "hidden") return;
      const current = new AbortController();
      controller = current;
      try {
        const data = open
          ? await request<Page>(
              cursor ? "?before=" + encodeURIComponent(cursor) : "",
              "GET",
              current.signal,
            )
          : await request<Counts>("/unread", "GET", current.signal);
        if (active && !current.signal.aborted) {
          setCounts({ unread: data.unread, through: data.through });
          if ("items" in data) setPage(data as Page);
          setError("");
        }
      } catch {
        if (active && !current.signal.aborted) {
          setPage(null);
          setError("Could not load notifications.");
        }
      } finally {
        if (active && !current.signal.aborted)
          timer = setTimeout(refresh, open ? 2000 : 10000);
      }
    };
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, cursor, revision]);
  async function mark(path: string) {
    if (writing) return;
    setWriting(true);
    try {
      setCounts(await request<Counts>(path, "PUT"));
      invalidate((r) => r + 1);
      if (channel.current) channel.current.postMessage("changed");
      else
        try {
          localStorage.setItem(channelName, crypto.randomUUID());
        } catch {
          /* Polling still synchronizes tabs. */
        }
    } catch {
      setError("Could not mark notifications as read.");
    } finally {
      setWriting(false);
    }
  }
  const move = (next: (string | null)[]) => {
    setPage(null);
    setCursors(next);
  };
  return (
    <>
      <Tooltip title="Notifications">
        <IconButton
          aria-label={`Notifications, ${counts.unread} unread`}
          onClick={() => {
            move([null]);
            setOpen(true);
          }}
        >
          <Badge badgeContent={counts.unread} color="error" max={999}>
            <NotificationsNone />
          </Badge>
        </IconButton>
      </Tooltip>
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        PaperProps={{
          role: "dialog",
          "aria-labelledby": "notification-title",
          sx: { width: "min(100vw, 420px)" },
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: 2.5, py: 1.5 }}
        >
          <Typography id="notification-title" variant="h6">
            Notifications
          </Typography>
          <IconButton
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          >
            <Close />
          </IconButton>
        </Stack>
        <Divider />
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: 2.5, py: 1 }}
        >
          <Typography variant="body2" color="text.secondary">
            {counts.unread} unread
          </Typography>
          <Button
            size="small"
            disabled={!page || !counts.unread || writing}
            onClick={() => void mark("/read-all?through=" + counts.through)}
          >
            Mark all as read
          </Button>
        </Stack>
        <Divider />
        <Box sx={{ overflowY: "auto", flex: 1 }}>
          {error && (
            <Alert
              severity="error"
              action={
                <Button onClick={() => invalidate((r) => r + 1)}>Retry</Button>
              }
            >
              {error}
            </Alert>
          )}
          {!page && !error && (
            <Typography sx={{ p: 2.5 }}>Loading notifications…</Typography>
          )}
          {page?.subscriptions && (
            <Stack
              component="section"
              aria-label="Active subscriptions"
              spacing={0}
              sx={{ pt: 1.25 }}
            >
              <Typography
                variant="subtitle2"
                component="h2"
                sx={{ px: 2, pb: 0.5 }}
              >
                Active Subscriptions
              </Typography>
              {page.subscriptions.length === 0 && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ px: 2, py: 0.5 }}
                >
                  No active subscriptions.
                </Typography>
              )}
              {page.subscriptions.map((s) => (
                <SubscriptionRow
                  key={s.id}
                  item={s}
                  onUnsubscribe={() => setConfirm(s)}
                />
              ))}
            </Stack>
          )}
          {page && (
            <Typography
              component="h2"
              variant="subtitle2"
              sx={{ px: 2, pt: 1.5, pb: 0.5 }}
            >
              Notification History
            </Typography>
          )}
          {page && !page.items.length && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 2, py: 0.5 }}
            >
              No notifications on this page.
            </Typography>
          )}
          {page?.items.map((n) => (
            <NotificationRow
              key={n.id}
              item={n}
              writing={writing}
              onRead={() => void mark("/" + n.id + "/read")}
            />
          ))}
        </Box>
        {(cursors.length > 1 || page?.next) && (
          <Stack direction="row" justifyContent="space-between" sx={{ p: 1 }}>
            <Button
              disabled={cursors.length === 1}
              onClick={() => move(cursors.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              disabled={!page?.next}
              onClick={() => page?.next && move([...cursors, page.next])}
            >
              Older
            </Button>
          </Stack>
        )}
      </Drawer>
      {confirm && (
        <Dialog
          open
          onClose={() => {
            if (!writing) setConfirm(null);
          }}
          aria-labelledby="unsubscribe-title"
        >
          <DialogTitle id="unsubscribe-title">
            Unsubscribe from {confirm.title || "this resource"}?
          </DialogTitle>
          <DialogContent>
            <Typography>
              Stop updates for this subscription. The remote task will continue.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button disabled={writing} onClick={() => setConfirm(null)}>
              Keep subscription
            </Button>
            <Button
              disabled={writing}
              onClick={async () => {
                setWriting(true);
                try {
                  await request("/subscriptions/" + confirm.id, "DELETE");
                  refreshResourceNotifications();
                  setConfirm(null);
                } catch {
                  setError("Could not unsubscribe. Refresh and try again.");
                  setConfirm(null);
                  invalidate((r) => r + 1);
                } finally {
                  setWriting(false);
                }
              }}
            >
              Unsubscribe
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
