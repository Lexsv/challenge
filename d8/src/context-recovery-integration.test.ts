import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "../server/sessions.mjs";
import { ManagerAgent, type ManagerLlmAdapter } from "./manager-agent";
import {
  createManagerLlmAdapter,
  ManagerProviderError,
} from "./manager-llm-adapter";
import { createBuiltInToolRegistry } from "./tool-runtime";
import { emptySession } from "./session-api";
import { restoreHistory, type HistoryEvent } from "./conversation-history";
import { ProviderRegistry } from "./provider-registry";
import { buildWeek2Timeline } from "./week2-agent-tool-lab";

it("migrates existing metering history without loss, persists summaries and restores context after a backend restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "d7-context-"));
  const database = join(folder, "sessions.sqlite");
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE history_events (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('message','run','tool-call','tool-result','metering')), payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sessionId,sequence));
    INSERT INTO sessions VALUES ('legacy', 'Existing session', 1);`);
  const legacyMeter = {
    id: "legacy-meter",
    sessionId: "legacy",
    runId: "legacy-run",
    provider: "openai",
    model: "gpt-4o-mini",
    library: "js-tiktoken",
    startedAt: 1,
    endedAt: 2,
    status: "completed",
    actualInputTokens: 4,
    actualOutputTokens: 2,
    actualTotalTokens: 6,
  };
  db.prepare("INSERT INTO history_events VALUES (?, ?, ?, ?, ?)").run(
    "legacy-event",
    "legacy",
    1,
    "metering",
    JSON.stringify(legacyMeter),
  );
  db.close();
  let server: ReturnType<typeof createSessionServer> | undefined;
  const start = async () => {
    server = createSessionServer(database, {
      credentialStore: {
        status: async () => false,
        read: async () => {
          throw new Error("No key");
        },
        save: async () => {},
        forget: async () => {},
      },
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return `http://127.0.0.1:${address.port}`;
  };
  const stop = () =>
    new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  try {
    let base = await start();
    const request = async (path: string, method = "GET", value?: unknown) => {
      const response = await fetch(base + "/api/sessions" + path, {
        method,
        headers: { Origin: base, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      const data = await response.json();
      expect(response.ok, JSON.stringify(data)).toBe(true);
      return data;
    };
    expect(await request("/legacy/events")).toMatchObject([
      { id: "legacy-event", type: "metering", payload: legacyMeter },
    ]);
    const session = await request("", "POST");
    const second = await request("", "POST");
    const state = emptySession(session);
    const registry = createBuiltInToolRegistry();
    const execute = vi.spyOn(registry, "executeById");
    const onEvent = async (event: HistoryEvent) => {
      await request("/" + session.id + "/events", "POST", event);
    };
    let calls = 0;
    const prior: ManagerLlmAdapter = {
      complete: async () =>
        ++calls === 1
          ? {
              toolCalls: [
                {
                  id: "conversion",
                  toolId: "builtin.currency_converter",
                  arguments: {
                    amount: 100,
                    fromCurrency: "CAD",
                    toCurrency: "JPY",
                    exchangeRate: 112.34567,
                  },
                },
              ],
            }
          : { text: "Completed explanation. ".repeat(150) },
    };
    for (let i = 0; i < 5; i++)
      expect(
        (
          await new ManagerAgent(prior, registry).run({
            state,
            userText: "Conversion question. ".repeat(80),
            onEvent,
          })
        ).error,
      ).toBeUndefined();
    const originals = await request("/" + session.id + "/events");
    const adapter: ManagerLlmAdapter = {
      context: {
        assess: async (messages) => ({
          tokens: messages.reduce((n, m) => n + m.content.length, 0),
          limit: 15000,
        }),
        summarize: async () => "A CAD to JPY conversion was completed.",
      },
      complete: async () => ({ text: "Ready to continue." }),
    };
    const result = await new ManagerAgent(adapter, registry).run({
      state,
      userText: "Continue with the saved conversion",
      onEvent,
    });
    expect(result.error).toBeUndefined();
    const summary = state.contextEvents!.find((e) => e.phase === "completed")!;
    expect(summary.summary).toContain("11234.567");
    const saved = await request("/" + session.id + "/events");
    expect(saved.slice(0, originals.length)).toEqual(originals);
    await stop();
    base = await start();
    expect(await request("/legacy/events")).toMatchObject([
      { id: "legacy-event", payload: legacyMeter },
    ]);
    expect(
      (await request("")).some((s: { id: string }) => s.id === "legacy"),
    ).toBe(true);
    const restoredEvents = await request("/" + session.id + "/events");
    const restored = restoreHistory(emptySession(session), restoredEvents);
    expect(restored.contextEvents).toEqual(state.contextEvents);
    expect(
      buildWeek2Timeline(restored, registry).some(
        (e) =>
          e.kind === "manager" && e.description.includes("Context compacted"),
      ),
    ).toBe(true);
    expect(await request("/" + second.id + "/events")).toEqual([]);
    const followup: ManagerLlmAdapter = {
      complete: async ({ messages }) => {
        expect(messages[0].content).toContain("11234.567");
        expect(messages[0].content).toContain("JPY");
        return { text: "10% tax uses the saved JPY amount." };
      },
    };
    await new ManagerAgent(followup, registry).run({
      state: restored,
      userText: "Add 10% tax to the first conversion",
      onEvent,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    // Boundaries are session scoped; a foreign event cannot become a summary anchor.
    const foreignRun = {
      id: "foreign-run",
      conversationId: second.id,
      agentId: "manager-agent",
      status: "running",
      startedAt: 1,
      messageIds: [],
      toolExecutionIds: [],
    };
    await request("/" + second.id + "/events", "POST", {
      id: "foreign-event",
      sessionId: second.id,
      type: "run",
      payload: foreignRun,
    });
    const invalid = await fetch(
      base + "/api/sessions/" + second.id + "/events",
      {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "foreign-summary",
          sessionId: second.id,
          type: "context",
          payload: { ...summary, runId: "foreign-run" },
        }),
      },
    );
    expect(invalid.status).toBe(400);
  } finally {
    if (server?.listening) await stop();
    await rm(folder, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "preserves sanitized structured overflow errors through direct and saved-key paths (%s)",
  async (saved) => {
    const folder = await mkdtemp(join(tmpdir(), "d7-overflow-"));
    const fake = "placeholder-fake-key";
    const store = {
      status: vi.fn(async () => true),
      read: vi.fn(async () => fake),
      save: vi.fn(async () => {}),
      forget: vi.fn(async () => {}),
    };
    let status = 400;
    let code = "context_length_exceeded";
    let message = `Maximum context length exceeded; do not expose ${fake}`;
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code, message } }), { status }),
    );
    const server = createSessionServer(join(folder, "sessions.sqlite"), {
      credentialStore: store,
      fetcher: upstream,
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const base = `http://127.0.0.1:${address.port}`;
      const responses: string[] = [];
      const fetcher: typeof fetch = async (url, init) => {
        const response = String(url).startsWith("/api/")
          ? await fetch(base + url, {
              ...init,
              headers: { ...init?.headers, Origin: base },
            })
          : await upstream(url, init);
        responses.push(await response.clone().text());
        return response;
      };
      const registry = new ProviderRegistry();
      registry.register({
        id: "opencode-console",
        catalog: () => ["gpt-4o-mini"],
        capabilities: () => undefined,
        limits: () => ({ contextWindow: 50000, maxOutputTokens: 4096 }),
        validate: () => undefined,
        execute: vi.fn(),
      });
      const adapter = createManagerLlmAdapter({
        providerId: "opencode-console",
        model: "gpt-4o-mini",
        apiKey: saved ? "" : fake,
        useSavedKey: saved,
        registry,
        fetcher,
      });
      let caught: unknown;
      try {
        await adapter.complete({
          messages: [{ role: "user", content: "Fake conversation" }],
          tools: [],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ManagerProviderError);
      expect((caught as ManagerProviderError).metadata).toEqual({
        kind: "context-overflow",
        status: 400,
        code: "context_length_exceeded",
      });
      expect(String(caught)).not.toContain(fake);
      if (saved) expect(responses[0]).not.toContain(fake);
      const outgoing = JSON.parse(upstream.mock.calls[0][1]!.body as string);
      expect(outgoing).toMatchObject({
        max_completion_tokens: 4096,
        tool_choice: "none",
        tools: [],
      });
      for (const next of [401, 403, 429, 500]) {
        status = next;
        await expect(
          adapter.complete({
            messages: [{ role: "user", content: "Fake" }],
            tools: [],
          }),
        ).rejects.toMatchObject({
          metadata: {
            kind: [401, 403].includes(next)
              ? "authentication"
              : next === 429
                ? "rate-limit"
                : "request",
            status: next,
          },
        });
      }
      status = 400;
      code = "invalid_schema";
      // An unrelated 400 must stay a request error.
      message = `Invalid tool schema ${fake}`;
      await expect(
        adapter.complete({ messages: [], tools: [] }),
      ).rejects.toMatchObject({ metadata: { kind: "request" } });
      // Exercise the complete Manager -> adapter -> saved-key route -> recovery path.
      const session = await (
        await fetch(base + "/api/sessions", { method: "POST" })
      ).json();
      const state = emptySession(session);
      const onEvent = async (event: HistoryEvent) => {
        const response = await fetch(
          base + "/api/sessions/" + session.id + "/events",
          {
            method: "POST",
            headers: { Origin: base, "Content-Type": "application/json" },
            body: JSON.stringify(event),
          },
        );
        expect(response.ok).toBe(true);
      };
      const tools = createBuiltInToolRegistry();
      const execute = vi.spyOn(tools, "executeById");
      const prior = new ManagerAgent(
        {
          complete: async () => ({
            text: "Previously completed discussion. ".repeat(100),
          }),
        },
        tools,
      );
      for (let i = 0; i < 4; i++)
        await prior.run({
          state,
          userText: "Earlier question. ".repeat(40),
          onEvent,
        });
      let attempts = 0;
      upstream.mockImplementation(async (_url, init) => {
        const payload = JSON.parse(init!.body as string);
        if (payload.tool_choice === "none")
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: "A summary of the previous discussion." },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
              },
            }),
          );
        attempts++;
        if (attempts === 1)
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "live-tax-call",
                        function: {
                          name: "builtin_tax_calculator",
                          arguments: JSON.stringify({
                            amount: 100,
                            taxRate: 10,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        if (attempts === 2)
          return new Response(
            JSON.stringify({
              error: { code: "context_length_exceeded", message: fake },
            }),
            { status: 400 },
          );
        expect(payload.messages.at(-1)).toMatchObject({
          role: "tool",
          tool_call_id: "live-tax-call",
        });
        expect(JSON.stringify(payload.messages)).toContain("110");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "The total is 110." } }],
          }),
        );
      });
      const recovered = await new ManagerAgent(adapter, tools).run({
        state,
        userText: "Calculate 10% tax on 100.",
        onEvent,
      });
      expect(recovered.error).toBeUndefined();
      expect(attempts).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(state.contextEvents!.map((event) => event.phase)).toEqual([
        "overflow",
        "compacting",
        "completed",
        "retrying",
      ]);
      expect(
        state.requestMeters!.filter((meter) => meter.status === "failed"),
      ).toHaveLength(1);
      const history: HistoryEvent[] = await (
        await fetch(base + "/api/sessions/" + session.id + "/events")
      ).json();
      expect(
        history.filter((event) => event.type === "tool-call"),
      ).toHaveLength(1);
      expect(
        history.filter((event) => event.type === "tool-result"),
      ).toHaveLength(1);
      expect(
        history.filter(
          (event) =>
            event.type === "message" &&
            event.payload.text === "Calculate 10% tax on 100.",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(history)).not.toContain(fake);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    }
  },
);
