import { localUiRequest } from "./mcp-routes.mjs";
import {proposalReceipt} from "./week3-memory-proposals.mjs";
import { randomUUID, createHash } from "node:crypto";
import { createInvariantStore } from "./session-invariants.mjs";
import { executeChatTurn, InvariantError } from "./invariant-turn.mjs";
import {
  redactLiterals,
  contextualRules,
  memoryRules,
  redactMemory,
  policyIssue,
} from "./invariant-validator.mjs";

async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new InvariantError(415, "JSON required.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) throw new InvariantError(413, "Request too large.");
    chunks.push(chunk);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString());
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new InvariantError(400, "Invalid JSON object.");
}
export function createInvariantRoutes(
  db,
  makeAdapter,
  compatibility = async () => null,
  week3Options = {},
) {
  const store = createInvariantStore(db);
  // Unrestricted browser turns hold a short renewable lease. Settings changes
  // wait until those turns finish; a closed tab cannot lock settings forever.
  const leases = new Map();
  const busy = new Set();
  function pending(key) {
    for (const [id, lease] of leases)
      if (lease.expires <= Date.now()) leases.delete(id);
    return [...leases.values()].some((l) => l.key === key);
  }
  async function route(req, path, reply) {
    const review = path.match(/^\/api\/week4\/sessions\/([\w-]+)\/mcp-review\/([a-f0-9-]{36})$/);
    if (review) {
      if (req.method !== "POST" || !localUiRequest(req,"review") || req.headers["x-day16-ui"] !== "review") {
        reply(403,{error:"Local review required."}); return true;
      }
      try {
        const body = await readBody(req);
        // Older open tabs may still poll. A decision can never authorize a call.
        const result = body.decision === undefined ? null : false;
        reply(result === false ? 409 : 200, {review:result});
      } catch { reply(400,{error:"Invalid review request."}); }
      return true;
    }
    const match = path.match(
      /^\/api\/(week[34]\/)?sessions\/([\w-]+)\/(invariants|invariant-turn)(?:\/([\w-]+))?$/,
    );
    if (!match) return false;
    const [, week, id, resource, item] = match;
    if (week === 'week4/' && resource !== 'invariant-turn') return false;
    let s, trace;
    try {
      s = store.scope(!!week, id);
      if (!s) throw new InvariantError(404, "Chat session not found.");
      if (resource === "invariants") {
        if (req.method === "GET" && !item) {
          reply(200, store.list(s));
          return true;
        }
        if (req.method === "GET" && item === "status") {
          const params = new URL(req.url, "http://localhost").searchParams;
          const budget = store.active(s).length
            ? await compatibility(
                s,
                params.get("provider"),
                params.get("model"),
              )
            : null;
          reply(200, { ...store.status(s), budget });
          return true;
        }
        if (req.method === "GET" && item === "audit") {
          reply(
            200,
            db
              .prepare(
                "SELECT invariant_id,action,previous_value,new_value,timestamp FROM invariant_audit_log WHERE session_id=? ORDER BY id",
              )
              .all(s.key),
          );
          return true;
        }
        const create = req.method === "POST" && !item,
          edit = req.method === "PATCH" && item,
          remove = req.method === "DELETE" && item;
        if (!create && !edit && !remove)
          throw new InvariantError(405, "Method not allowed.");
        const value = remove ? null : await readBody(req);
        if (
          value &&
          (!Object.keys(value).length ||
            Object.keys(value).some((k) => !["text", "enabled"].includes(k)) ||
            (edit && Object.keys(value).length !== 1) ||
            ((create || "text" in value) &&
              (typeof value.text !== "string" ||
                !value.text.trim() ||
                value.text.length > 1000 ||
                /[\u0000-\u0008]/u.test(value.text))) ||
            ("enabled" in value && typeof value.enabled !== "boolean"))
        )
          throw new InvariantError(400, "Enter a rule of 1–1000 characters.");
        if (value?.text) value.text = value.text.trim();
        if (pending(s.key))
          throw new InvariantError(
            409,
            "A chat turn is running. Try again when it finishes.",
          );
        db.exec("BEGIN IMMEDIATE");
        try {
          if (create && store.list(s).length >= 32)
            throw new InvariantError(400, "A session supports up to 32 rules.");
          if (!store.change(s, item, value))
            throw new InvariantError(404, "Invariant not found.");
          if (!remove && value?.enabled !== false) {
            const issue = policyIssue(store.active(s));
            if (issue) throw new InvariantError(422, issue);
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        reply(create ? 201 : 200, store.list(s));
        return true;
      }
      if (item && ["DELETE", "PATCH"].includes(req.method)) {
        const lease = leases.get(item);
        if (lease?.key !== s.key || lease.expires <= Date.now())
          throw new InvariantError(409, "Turn expired.");
        if (req.method === "DELETE") leases.delete(item);
        else lease.expires = Date.now() + 300000;
        reply(200, { ok: true });
        return true;
      }
      if (item || req.method !== "POST")
        throw new InvariantError(405, "Method not allowed.");
      const input = await readBody(req);
      if (
        Object.keys(input).some(
          (k) => !["model", "provider", "question", "turnId", ...(s.week3 ? ["execute"] : [])].includes(k),
        ) ||
        (input.execute !== undefined && input.execute !== true) ||
        (input.turnId !== undefined &&
          (typeof input.turnId !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
              input.turnId,
            ))) ||
        !["openai", "opencode-go", "opencode-console"].includes(
          input.provider,
        ) ||
        typeof input.model !== "string" ||
        !input.model.trim() ||
        input.model.length > 200 ||
        typeof input.question !== "string" ||
        !input.question.trim() ||
        input.question.length > 32000
      )
        throw new InvariantError(400, "Invalid chat request.");
      const rules = store.active(s);
      input.turnId ??= randomUUID();
      input.fingerprint = createHash("sha256")
        .update(
          JSON.stringify([s.id, input.provider, input.model, input.question]),
        )
        .digest("hex");
      if (s.week3) trace = {turnId:input.turnId,stage:"session_initialization"};
      const receipt = s.week3 && proposalReceipt(db,s.id,input.turnId);
      if (receipt) {
        if (receipt.fingerprint!==input.fingerprint) throw new InvariantError(409,"Turn identifier already used.");
        reply(200,{status:"completed",redacted:!!receipt.redacted});
        return true;
      }
      const prior = store.securityEvent(s, input.turnId);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint)
          throw new InvariantError(409, "Turn identifier already used.");
        if (prior.action === "blocked")
          throw new InvariantError(
            422,
            "Request blocked",
            rules.find((r) => r.id === prior.invariant_id),
          );
        reply(200, { status: "completed", redacted: true });
        return true;
      }
      const issue = policyIssue(rules);
      if (issue) throw new InvariantError(409, issue);
      if (!rules.length && !input.execute) {
        pending(s.key);
        const token = randomUUID();
        leases.set(token, { key: s.key, expires: Date.now() + 300000 });
        reply(200, { status: "unrestricted", token });
        return true;
      }
      if (busy.has(s.key))
        throw new InvariantError(409, "A protected turn is already running.");
      const foundation=week3Options.week4Execution;
      if (s.week3 && foundation.service.journal.run(input.turnId)) throw new InvariantError(409,'Execution already recorded. Check its outcome before repeating this request.');
      busy.add(s.key);
      let durable;
      try {
        if (week === 'week4/') {
          durable = foundation.begin(s.id,input,["execute","review"].includes(req.headers["x-day16-ui"]) && localUiRequest(req,req.headers["x-day16-ui"]));
          durable.ctx.privatePayloads = rules.length > 0;
        }
        const perform=()=>executeChatTurn(
            db,
            store,
            s,
            rules,
            input,
            makeAdapter,
            compatibility,
            week3Options,
            trace, durable,
          );
        reply(200,await (durable ? durable.within(perform) : perform()));
      } catch(error) {
        if (durable && foundation.service.journal.run(input.turnId)?.owner===foundation.service.journal.owner) {
          const ctx=durable.ctx;
          const answer=ctx.failure?.code==='refusal'?'refused':ctx.controller.signal.aborted?'cancelled':'failed';
          foundation.service.journal.transaction(()=>foundation.service.finish(ctx,answer,trace?.stage==='commit'?'persistence':'execution_error'));
        }
        throw error;
      } finally {
        if(durable) foundation.service.release(durable.ctx);
        busy.delete(s.key);
      }
    } catch (e) {
      const status = e instanceof InvariantError ? e.status : 503;
      reply(status, {
        ...(trace && status === 503 ? trace : {}),
        error:
          e instanceof InvariantError
            ? e.message
            : trace?.stage === "provider_setup"
              ? "The selected provider or model could not be prepared for this turn."
              : "Mandatory validation is unavailable. Check the configured provider and retry.",
        ...(e instanceof InvariantError && e.rule ? { rule: redactLiterals(e.rule, store.active(s)), invariantId: e.ruleId } : {}),
      });
    }
    return true;
  }
  function guard(req, path) {
    const m = path.match(
      /^\/api\/(week3\/)?sessions\/([\w-]+)\/(events|facts|memory|segments|turn-completion)(?:$)/,
    );
    if (!m) return;
    const s = store.scope(!!m[1], m[2]);
    if (!s) return;
    if (req.method !== "GET") {
      if (store.active(s).length)
        throw new InvariantError(409, "This chat requires a protected turn.");
      return;
    }
    if (m[3] === "events") {
      return (value) => {
        const view = store.historyView(s);
        const events = (rows) => rows.map(view);
        return Array.isArray(value)
          ? events(value)
          : {
              ...value,
              events: events(value.events),
              ...(value.accountingEvents
                ? { accountingEvents: events(value.accountingEvents) }
                : {}),
            };
      };
    }
    // Memory can contain derived provider content predating the current policy.
    // Without proof of a semantic review, withhold the derived view.
    return (value) => {
      const rules = store.active(s);
      if (!rules.length) return value;
      if (
        store.approved(s, rules, {
          type: m[3],
          id: m[3] + "/" + s.id,
          payload: value,
        })
      )
        return value;
      const safe = contextualRules(s.week3 && m[3] === "memory" ? memoryRules(rules) : rules).length
        ? undefined
        : redactMemory(value, rules);
      return (
        safe ??
        (m[3] === "facts"
          ? { facts: [], coveredMessageId: null }
          : s.week3
            ? { revision: value.revision, data: null }
            : { revision: value.revision, entries: [] })
      );
    };
  }
  return {
    route,
    guard,
    historyView(id) { return store.historyView(store.scope(false, id)); },
    sealCopiedHistory(id) { store.sealCopiedHistory(store.scope(false, id)); },
    copyRules(source, target) {
      const from = store.scope(false, source),
        to = store.scope(false, target);
      for (const r of store.list(from))
        store.change(to, null, { text: r.text, enabled: r.enabled });
    },
  };
}
