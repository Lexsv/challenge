import { parameterRows } from "../src/mcp-parameters.ts";
import {containsCredential, journalableMcpContent, sanitizedCapture, safeResourceUri} from "./journal-payload.mjs";
import { randomUUID } from "node:crypto";
import { McpProblem, parseConfiguration } from "./mcp-configuration.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { normalizeMcpResult, mcpFailure, recordConsumedLinks } from "./mcp-executor.mjs";
import { createResourceWatches } from "./mcp-resource-watches.mjs";
import { discoverServer, mcpSession } from "./mcp-discovery.mjs";

export function createMcpConnectionManager(db, store, options = {}, repo = createMcpRepository(db)) {
  const recordStream = db.prepare("UPDATE mcp_connections SET sse_observed=? WHERE id=? AND revision=? AND sse_observed IS NOT ?");
  const activeStreams = new Map();
  const streamKey = c => c.connectionId + ":" + c.revision;
  options = {...options, openSse(config) {
    const key = streamKey(config);
    activeStreams.set(key, (activeStreams.get(key) ?? 0) + 1);
    return () => {
      const remaining = activeStreams.get(key) - 1;
      if (remaining) activeStreams.set(key, remaining);
      else activeStreams.delete(key);
    };
  }, observeSse(config, value) {
    try { recordStream.run(+value, config.connectionId, config.revision, +value); } catch { /* Observation cannot fail an MCP operation. */ }
  }};
  const watches = createResourceWatches(db, repo, credentialValues, id => manager.refresh(id), options);
  const savedWatchCount = db.prepare(`SELECT count(*) AS n FROM mcp_tool_watch_settings s
    JOIN mcp_tools t ON t.id=s.tool_id WHERE t.connection_id=? AND t.present=1 AND s.revision=? AND s.enabled=1`);
  function indicators(c) {
    return {...c, sseActive:activeStreams.has(streamKey(c)),
      watchToolCount:savedWatchCount.get(c.connectionId,c.revision).n,
      watchEnabled:watches.watchEnabled(c.connectionId)};
  }
  const busy = new Set();
  const discoveries = new Map();
  async function credentialValues(r) {
    let values = [];
    if (r.credential_ref) {
      try {
        values = JSON.parse(await store.read(r.credential_ref));
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.some((v) => typeof v !== "string" || !v)
        )
          throw Error();
      } catch {
        throw new McpProblem("credential", 503);
      }
    }

    return values;
  }
  // A lease is exclusive to one attempt. Idle clients never cross chat sessions.
  const available = db.prepare("SELECT 1 FROM mcp_tools WHERE id=? AND connection_id=? AND original_name=? AND present=1");
  const leases = new Set();
  let stopped = false;
  async function dispose(lease) {
    clearTimeout(lease.timer);
    lease.closed = true;
    try {
      await lease.session?.close();
    } finally {
      leases.delete(lease);
    }
  }
  async function invalidate(id) {
    await Promise.all(
      [...leases].filter((l) => !id || l.id === id).map(dispose),
    );
  }
  async function execute(destination, signal, current) {
    const { connectionId: id, toolId, revision, sessionId } = destination;
    let lease,
      healthy = false,
      callDispatched = false,
      stage = "dispatch";
    try {
      const check = () =>
        !signal.aborted &&
        !stopped &&
        !lease?.closed &&
        current() &&
        repo.row(id).revision === revision &&
        !repo.row(id).deletion_pending && !!available.get(toolId,id,destination.originalName);
      if (
        !check() ||
        !["read-only", "side-effecting"].includes(destination.safety) ||
        !destination.grantId
      )
        throw new McpProblem("permission");
      lease = [...leases].find(
        (l) =>
          !l.busy &&
          !l.closed &&
          l.id === id &&
          l.revision === revision &&
          l.sessionId === sessionId,
      );
      if (!lease) {
        // Evict idle leases first, including leases for other sessions of this connection.
        if (
          [...leases].filter((l) => l.id === id).length >= 4 ||
          leases.size >= 32
        ) {
          const idle = [...leases].find(
            (l) =>
              !l.busy &&
              (l.id === id ||
                [...leases].filter((x) => x.id === id).length < 4),
          );
          if (idle) await dispose(idle);
        }
        if (
          leases.size >= 32 ||
          [...leases].filter((l) => l.id === id).length >= 4
        )
          throw new McpProblem("busy");
        lease = { id, revision, sessionId, busy: true };
        leases.add(lease);
        lease.values = await credentialValues(repo.row(id));
        if (!check()) throw new McpProblem("permission");
        lease.session = mcpSession(repo.get(id), lease.values, options);
        const caps = await lease.session.open(signal);
        if (!caps.tools) throw new McpProblem("discovery");
      }
      clearTimeout(lease.timer);
      lease.busy = true;
      if (!check()) throw new McpProblem("permission");
      const raw = await lease.session.call(
        destination.originalName,
        destination.arguments,
        signal,
        check,
        destination.capture,
        () => { callDispatched = true; },
      );
      stage = "response";
      if (!check()) throw new McpProblem("result");
      let output;
      try {
        output = normalizeMcpResult(raw, destination, lease.values);
      } catch (error) {
        // This is the decoded tool return, including for SSE, never a reconstructed wire payload.
        const diagnostic = sanitizedCapture(JSON.stringify(raw), lease.values, journalableMcpContent) ||
          JSON.stringify({omitted:true, ...error.resultDetails, hasStructuredContent:!!raw?.structuredContent});
        destination.capture?.("returned", diagnostic);
        throw error;
      }
      try {
        if (raw.content?.some(b => b.type === "resource_link" && safeResourceUri(b.uri, lease.values)))
          db.prepare(`INSERT INTO mcp_tool_event_observations(tool_id,link_revision,typed_link_revision)
            SELECT id,?,? FROM mcp_tools WHERE id=? AND connection_id=? AND present=1
            ON CONFLICT(tool_id) DO UPDATE SET link_revision=excluded.link_revision,typed_link_revision=excluded.typed_link_revision`).run(revision,revision,toolId,id);
        const consumed = watches.capture(destination, raw, lease.values);
        recordConsumedLinks(output, consumed);
      } catch {
        // A local watch setup failure must never cause a completed write to replay.
        output.resourceWatchWarning = "Resource watch registration could not be confirmed.";
      }
      destination.capture?.("returned", sanitizedCapture(JSON.stringify(output), lease.values));
      healthy = true;
      return { ok: true, toolId, output };
    } catch (error) {
      const failure = mcpFailure(toolId, error, signal, stage);
      if (!callDispatched) failure.error.effectEvidence = "pre_dispatch";
      return failure;
    } finally {
      if (lease) {
        if (!healthy || lease.closed || signal.aborted || stopped)
          await dispose(lease);
        else {
          lease.busy = false;
          lease.timer = setTimeout(() => {
            void dispose(lease);
          }, options.idleMs ?? 30000);
          lease.timer.unref();
        }
      }
    }
  }
  async function saveConfiguration(id, body, editing) {
    const { config, secretValues } = parseConfiguration(body);
    const old = editing ? repo.row(id) : undefined;
    if (editing ? old.revision !== body.revision : body.revision !== undefined)
      throw new McpProblem("conflict", 409);
    if (old?.deletion_pending) throw new McpProblem("deleting", 409);
    repo.checkEndpoint(config.endpoint, id);
    repo.checkName(config.name, id);
    const changed =
      !old ||
      old.transport !== config.transport ||
      old.endpoint !== config.endpoint ||
      old.auth !== JSON.stringify(config.auth);
    let ref = null;
    const oldAuth = old && JSON.parse(old.auth);
    if (oldAuth?.type === config.auth.type) {
      const privateKeys = new Set(
        parameterRows(oldAuth)
          .filter((r) => r.secret)
          .map((r) => r.key),
      );
      if (
        parameterRows(config.auth).some(
          (r) => !r.secret && privateKeys.has(r.key),
        )
      )
        throw new McpProblem("invalid", 400);
    }
    const secretRows = parameterRows(config.auth).filter((r) => r.secret);
    if (secretRows.length) {
      if (secretValues === undefined) {
        if (changed || !old.credential_ref)
          throw new McpProblem("invalid", 400);
        ref = old.credential_ref;
      } else {
        const retained = secretValues.includes(null);
        if (
          retained &&
          (!old ||
            old.endpoint !== config.endpoint ||
            old.transport !== config.transport ||
            JSON.parse(old.auth).type !== config.auth.type)
        )
          throw new McpProblem("invalid", 400);
        const previous = retained
          ? parameterRows(JSON.parse(old.auth)).filter((r) => r.secret)
          : [];
        const stored = retained ? await credentialValues(old) : [];
        const values = secretValues.map(
          (v, i) =>
            v ?? stored[previous.findIndex((r) => r.key === secretRows[i].key)],
        );
        if (values.some((v) => !v) || containsCredential(config, values))
          throw new McpProblem("invalid", 400);
        ref = "mcp-" + randomUUID();
        try {
          await store.save(ref, JSON.stringify(values));
        } catch {
          throw new McpProblem("credential", 503);
        }
      }
    }
    let saved;
    try {
      saved = repo.save(
        id,
        config,
        ref,
        old?.revision,
        changed || !!secretValues,
      );
    } catch (error) {
      if (ref && ref !== old?.credential_ref)
        await store.forget(ref).catch(() => {});
      throw error;
    }
    if (old?.credential_ref && old.credential_ref !== ref)
      await store.forget(old.credential_ref).catch(() => {});
    if (editing) { watches.sweep(); await invalidate(id); }
    return indicators(saved);
  }
  async function synchronize(id, signal) {
    const r = repo.row(id);
    if (r.deletion_pending) throw new McpProblem("deleting", 409);
    repo.checkEndpoint(r.endpoint, id);
    let listing;
    try {
      const values = await credentialValues(r);
      const config = repo.get(id);
      signal.throwIfAborted();
      listing = await discoverServer(config, values, {
        ...options,
        signal,
      });
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw new McpProblem("cancelled", 409);
      repo.fail(
        id,
        r.revision,
        error instanceof McpProblem ? error.code : "unknown",
      );
      throw error;
    }
    const {tools, capabilities, resources, resourceError, toolFailure} = listing;
    const result = repo.synchronize(id,r.revision,tools,capabilities,resources,resourceError,toolFailure?.code);
    watches.refreshed(id);
    if (toolFailure) throw toolFailure;
    return indicators(result);
  }

  async function exclusive(id, operation) {
    if (busy.has(id)) throw new McpProblem("busy", 409);
    busy.add(id);
    try {
      return await operation();
    } finally {
      busy.delete(id);
    }
  }
  const manager = {
    updateWatches: watches.sweep,
    execute,
    close: () => {
      stopped = true;
      const pending = [...discoveries.values()];
      for (const discovery of pending) discovery.controller.abort();
      return Promise.all([invalidate(), watches.close(), Promise.allSettled(pending.map(d => d.done))]);
    },
    async reveal(id, revision, key) {
      const row = repo.row(id);
      if (row.deletion_pending || row.revision !== revision) throw new McpProblem("conflict", 409);
      const index = parameterRows(JSON.parse(row.auth)).filter(r => r.secret).findIndex(r => r.key === key);
      if (index < 0) throw new McpProblem("invalid", 400);
      const values = await credentialValues(row);
      if (repo.row(id).revision !== revision) throw new McpProblem("conflict", 409);
      if (typeof values[index] !== "string") throw new McpProblem("credential", 503);
      return { value: values[index] };
    },
    executionMode: repo.executionMode,
    saveExecutionMode: repo.saveExecutionMode,
    visibleWatchIds: watches.visibleIds,
    subscriptionIds: watches.subscriptionIds,
    unsubscribe: watches.unsubscribe,
    configureWatching(id,toolId,revision,enabled) {
      watches.configure(id,toolId,revision,enabled);
      return manager.catalog(id);
    },
    list: () => repo.list().map(indicators),
    catalog(id) {
      const catalog = repo.catalog(id);
      catalog.connection = indicators(catalog.connection);
      for (const t of catalog.tools) {
        t.watchEnabled = watches.watchEnabled(id,t.toolId);
        t.watchAttachedChats = watches.configured(t.toolId,catalog.connection.revision);
      }
      return catalog;
    },
    save(id, body) {
      const key = id ?? randomUUID();
      if (discoveries.has(key)) throw new McpProblem("busy", 409);
      return exclusive(key, () => saveConfiguration(key, body, !!id));
    },
    async refresh(id) {
      if (stopped) throw new McpProblem("cancelled", 409);
      if (busy.has(id) || discoveries.has(id))
        throw new McpProblem("busy", 409);
      const controller = new AbortController();
      const done = synchronize(id, controller.signal);
      discoveries.set(id, { controller, done });
      try {
        return await done;
      } finally {
        discoveries.delete(id);
      }
    },
    removeTool(id, toolId, revision) {
      return exclusive(id, () => {
        if (discoveries.has(id)) throw new McpProblem("busy", 409);
        repo.removeTool(id, toolId, revision);
        watches.sweep();
        return manager.catalog(id);
      });
    },
    remove(id, revision) {
      return exclusive(id, async () => {
        if (!db.prepare("SELECT 1 FROM mcp_connections WHERE id=?").get(id)) return { connectionId: id };
        const ref = repo.markDeleting(id, revision);
        watches.sweep();
        await invalidate(id);
        const active = discoveries.get(id);
        if (active) {
          active.controller.abort();
          await active.done.catch(() => {});
        }
        if (ref) {
          try {
            await store.forget(ref);
          } catch {
            throw new McpProblem("cleanup", 503);
          }
        }
        try {
          repo.finishDeletion(id);
        } catch {
          throw new McpProblem("delete_failed", 503);
        }
        return { connectionId: id };
      });
    },
  };
  return manager;
}
