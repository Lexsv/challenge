import { parameterRows } from "../src/mcp-parameters.ts";
import {containsCredential, journalableMcpContent, sanitizedCapture} from "./journal-payload.mjs";
import { randomUUID } from "node:crypto";
import { McpProblem, parseConfiguration } from "./mcp-configuration.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { normalizeMcpResult, mcpFailure } from "./mcp-executor.mjs";
import { discoverCatalog, mcpSession } from "./mcp-discovery.mjs";

export function createMcpConnectionManager(db, store, options = {}) {
  const repo = createMcpRepository(db);
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
      stage = "dispatch";
    try {
      const check = () =>
        !signal.aborted &&
        !stopped &&
        !lease?.closed &&
        current() &&
        repo.row(id).revision === revision &&
        !repo.row(id).deletion_pending;
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
        await lease.session.open(signal);
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
      destination.capture?.("returned", sanitizedCapture(JSON.stringify(output), lease.values));
      healthy = true;
      return { ok: true, toolId, output };
    } catch (error) {
      return mcpFailure(toolId, error, signal, stage);
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
    if (editing) await invalidate(id);
    return saved;
  }
  async function synchronize(id, signal) {
    const r = repo.row(id);
    if (r.deletion_pending) throw new McpProblem("deleting", 409);
    repo.checkEndpoint(r.endpoint, id);
    try {
      const values = await credentialValues(r);
      const config = repo.get(id);
      signal.throwIfAborted();
      const tools = await discoverCatalog(config, values, {
        ...options,
        signal,
      });
      signal.throwIfAborted();
      return repo.synchronize(id, r.revision, tools);
    } catch (error) {
      if (signal.aborted) throw new McpProblem("cancelled", 409);
      repo.fail(
        id,
        r.revision,
        error instanceof McpProblem ? error.code : "unknown",
      );
      throw error;
    }
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
  return {
    execute,
    close: () => {
      stopped = true;
      return invalidate();
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
    list: repo.list,
    catalog: repo.catalog,
    save(id, body) {
      const key = id ?? randomUUID();
      if (discoveries.has(key)) throw new McpProblem("busy", 409);
      return exclusive(key, () => saveConfiguration(key, body, !!id));
    },
    async refresh(id) {
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
    remove(id, revision) {
      return exclusive(id, async () => {
        const ref = repo.markDeleting(id, revision);
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
}
