import {
  ToolListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpSession } from "./mcp-discovery.mjs";
import {
  createWatchStore,
  resourceWatchPolicy,
} from "./mcp-resource-watch-store.mjs";

// One SDK subscription per connection revision and URI. Each chat origin is
// independently authorized before recording an observation. Notifications only schedule reads; they never run tools.
export function createResourceWatches(
  db,
  repo,
  credentialValues,
  refresh,
  options,
) {
  let configured;
  try {
    configured =
      options.watchPolicy ??
      JSON.parse(process.env.DAY18_MCP_RESOURCE_WATCH_POLICY ?? "[]");
  } catch {
    throw Error("Invalid MCP resource watch policy JSON");
  }
  const policy = resourceWatchPolicy(configured);
  const defaultWatching = options.defaultAutomaticWatching ??
    (process.env.DAY18_MCP_AUTO_WATCH_DEFAULT ?? "true") === "true";
  const store = createWatchStore(db, policy, defaultWatching);
  const groups = new Map(),
    closing = new Set();
  const interval = options.watchSweepMs ?? 5000;
  const recoveryMs = options.watchReconcileMs ?? 60000;
  let stopped = false,
    timer;
  const keyOf = (w) => JSON.stringify([w.connection_id, w.revision]);

  function trackClose(client, subscriptions) {
    if (!client) return;
    const done = (async () => {
      const remaining = subscriptions.values();
      async function release() {
        for (const uri of remaining) {
          const signal = AbortSignal.timeout(1000);
          await client.client
            .unsubscribeResource({ uri }, { signal, timeout: 1000 })
            .catch(() => {});
        }
      }
      try {
        await Promise.all(Array.from({ length: 4 }, release));
      } finally {
        await client.close();
      }
    })().catch(() => {});
    closing.add(done);
    void done.finally(() => closing.delete(done));
  }
  function invalidate(g, graceful = false) {
    const old = g.session;
    g.session = null;
    g.controller?.abort();
    const subscriptions = graceful ? new Set(g.subscribed.keys()) : [];
    if (graceful && g.pendingSubscribe) subscriptions.add(g.pendingSubscribe);
    g.blocked.clear();
    g.subscribed.clear();
    g.dirty.clear();
    trackClose(old, subscriptions);
  }
  function fail(g, error) {
    if (!g.session && !g.controller) return;
    invalidate(g);
    const permanent = [
      "authentication",
      "permission",
      "credential",
      "unsupported",
    ].includes(error?.code);
    g.retryAt = permanent
      ? Infinity
      : Date.now() +
        Math.min(
          60000,
          (options.watchRetryMs ?? 1000) * 2 ** Math.min(g.failures++, 6),
        ) *
          (0.8 + Math.random() * 0.4);
    for (const w of [...g.watches.values()].flat())
      store.status(w, permanent ? "suspended" : "reconnecting");
  }
  function live(g, signal) {
    return !stopped && !signal.aborted && groups.get(g.key) === g;
  }
  async function pump(g) {
    if (g.job || g.retryAt > Date.now() || stopped || groups.get(g.key) !== g)
      return;
    const work = async () => {
      if (!g.session) {
        g.controller = new AbortController();
        const signal = g.controller.signal;
        const values = await credentialValues(repo.row(g.id));
        if (!live(g, signal)) return;
        g.values = values;
        const session = mcpSession(repo.get(g.id), values, {
          ...options,
          resourceAccess(uri) {
            return (
              live(g, signal) &&
              !!g.watches.get(uri)?.some((w) => store.allowed(w))
            );
          },
        });
        g.session = session;
        const disconnected = (error) => {
          if (live(g, signal)) fail(g, session.lastError() ?? error);
        };
        session.client.onclose = disconnected;
        session.client.onerror = (error) => {
          // The request promise handles a denial for one URI. Other resources on
          // the same authenticated client can still be accessible.
          if (
            g.pendingUnsubscribe ||
            (g.pendingUri && error?.code === "permission")
          )
            return;
          disconnected(error);
        };
        session.client.setNotificationHandler(
          ResourceUpdatedNotificationSchema,
          ({ params }) => {
            if (!live(g, signal) || !g.watches.has(params.uri)) return;
            g.dirty.add(params.uri);
            void pump(g);
          },
        );
        session.client.setNotificationHandler(
          ResourceListChangedNotificationSchema,
          () => {
            if (live(g, signal) && g.listChanged) g.catalogDirty = true;
          },
        );
        session.client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          () => {
            if (live(g, signal) && g.toolsListChanged) g.catalogDirty = true;
          },
        );
        const caps = await session.open(signal);
        g.toolsListChanged = caps.toolsListChanged;
        if (!live(g, signal)) return;
        if (!caps.subscribe)
          throw Object.assign(Error(), { code: "unsupported" });
        g.listChanged = caps.resourcesListChanged;
      }
      const session = g.session,
        signal = g.controller.signal;
      if (!session || !live(g, signal)) return;
      const request = { signal, timeout: options.discoveryMs ?? 10000 };
      for (const uri of g.subscribed.keys()) {
        if (g.watches.has(uri)) continue;
        g.subscribed.delete(uri);
        g.pendingUnsubscribe = uri;
        try {
          await session.client.unsubscribeResource({ uri }, request);
        } catch {
          // Local revocation is final. Late events for this URI are ignored.
          // The normal disconnect handler recovers any surviving watches.
        } finally {
          g.pendingUnsubscribe = null;
        }
      }
      for (const [uri, origins] of g.watches) {
        if (!live(g, signal)) return;
        const dirty = g.dirty.delete(uri);
        if (
          !origins.some((w) => store.allowed(w)) ||
          g.blocked.get(uri) > Date.now()
        )
          continue;
        const first = !g.subscribed.has(uri);
        if (
          !first &&
          !dirty &&
          origins.every((w) => w.digest) &&
          Date.now() < g.reconcileAt
        )
          continue;
        try {
          g.pendingUri = uri;
          g.pendingController = new AbortController();
          const resourceRequest = {
            ...request,
            signal: AbortSignal.any([signal, g.pendingController.signal]),
          };
          if (first) {
            g.pendingSubscribe = uri;
            await session.client.subscribeResource({ uri }, resourceRequest);
            if (!live(g, signal)) return;
            g.subscribed.set(uri, true);
          }
          if (!g.watches.get(uri)?.some((w) => store.allowed(w))) continue;
          const result = await session.client.readResource(
            { uri },
            resourceRequest,
          );
          let finished = false;
          if (live(g, signal))
            for (const w of g.watches.get(uri) ?? []) {
              if (
                store.observe(
                  w,
                  result.contents,
                  g.values,
                  !dirty,
                  session.pushUnavailable() ? "polling" : "active",
                )
              )
                finished = true;
            }
          if (finished) queueMicrotask(sweep);
        } catch (error) {
          if (!live(g, signal)) return;
          if (g.pendingController.signal.aborted) {
            // A revoked subscription may have reached the server before its acknowledgement.
            if (g.pendingSubscribe) g.subscribed.set(uri, true);
            continue;
          }
          const problem = session.lastError() ?? error;
          if (problem.code === "permission") {
            g.blocked.set(uri, Infinity);
            for (const w of origins) store.status(w, "suspended");
          } else if (problem.code === -32002) {
            g.blocked.set(uri, Date.now() + recoveryMs);
            for (const w of origins) store.status(w, "unavailable");
          } else throw problem;
        } finally {
          g.pendingUri = null;
          g.pendingSubscribe = null;
          g.pendingController = null;
        }
      }
      g.failures = 0;
      if (Date.now() >= g.reconcileAt) g.reconcileAt = Date.now() + recoveryMs;
    };
    g.job = work()
      .catch((error) => {
        if (
          !stopped &&
          groups.get(g.key) === g &&
          !g.controller?.signal.aborted
        ) {
          try {
            fail(g, g.session?.lastError() ?? error);
          } catch {
            sweep();
          }
        }
      })
      .finally(() => {
        g.job = null;
        if (
          !stopped &&
          groups.get(g.key) === g &&
          (g.dirty.size ||
            [...g.subscribed.keys()].some((uri) => !g.watches.has(uri))) &&
          g.retryAt <= Date.now()
        )
          setImmediate(() => {
            if (groups.get(g.key) === g) void pump(g);
          });
      });
    return g.job;
  }
  function synchronizeGroups() {
    if (stopped) return;
    const wanted = new Map();
    for (const w of store.desired()) {
      const key = keyOf(w);
      if (!wanted.has(key)) wanted.set(key, new Map());
      const byUri = wanted.get(key);
      if (!byUri.has(w.uri)) byUri.set(w.uri, []);
      byUri.get(w.uri).push(w);
    }
    for (const [key, g] of groups)
      if (!wanted.has(key)) {
        groups.delete(key);
        invalidate(g, true);
      }
    for (const [key, watches] of wanted) {
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          id: watches.values().next().value[0].connection_id,
          subscribed: new Map(),
          blocked: new Map(),
          dirty: new Set(),
          retryAt: 0,
          reconcileAt: 0,
          failures: 0,
        };
        groups.set(key, g);
      }
      if (g.pendingUri && !watches.has(g.pendingUri))
        g.pendingController?.abort();
      g.watches = watches;
      for (const uri of g.blocked.keys())
        if (!watches.has(uri)) g.blocked.delete(uri);
      for (const uri of g.dirty) if (!watches.has(uri)) g.dirty.delete(uri);
      if (g.catalogDirty && !g.refreshing) {
        g.catalogDirty = false;
        g.refreshing = refresh(g.id)
          .catch(() => {})
          .finally(() => {
            g.refreshing = null;
          });
      }
      void pump(g);
    }
  }
  let degraded = false;
  function sweep() {
    try {
      synchronizeGroups();
      degraded = false;
    } catch {
      // A failed policy/storage lookup must not leave clients using stale grants.
      for (const g of groups.values()) invalidate(g);
      groups.clear();
      if (!degraded)
        console.warn("MCP resource watch reconciliation is unavailable.");
      degraded = true;
    }
  }
  timer = setInterval(sweep, interval);
  timer.unref();
  queueMicrotask(sweep);
  return {
    sweep,
    visibleIds: store.visibleIds,
    subscriptionIds: store.subscriptionIds,
    configured: store.configured,
    configure(...args) {
      store.configure(...args);
      sweep();
    },
    unsubscribe(id) {
      const found = store.unsubscribe(id);
      sweep();
      return found;
    },
    watchEnabled: store.watchEnabled,
    refreshed(id) {
      for (const g of groups.values())
        if (g.id === id) {
          if (g.retryAt === Infinity) g.retryAt = 0;
          g.blocked.clear();
          g.reconcileAt = 0;
        }
      sweep();
    },
    capture(destination, raw, values) {
      const consumed = store.capture(destination, raw.content ?? [], values);
      if (consumed) sweep();
      return consumed;
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      const jobs = [];
      for (const g of groups.values()) {
        invalidate(g, true);
        jobs.push(g.job, g.refreshing);
      }
      groups.clear();
      await Promise.allSettled([...closing, ...jobs]);
    },
  };
}
