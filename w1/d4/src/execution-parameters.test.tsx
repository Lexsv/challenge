import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./engine";
import { respond } from "./openai";
import { settings, type Expert } from "./models";
import { captureExecutionParameters } from "./execution-parameters";
import { ExecutionParametersReport } from "./execution-parameters-report";
import { ParticipantDetails } from "./results";
const parameter = (key: string, value: string, enabled = true) => ({
  id: key,
  key,
  value,
  enabled,
});
const makeExpert = (id: string, temp: number): Expert => ({
  ...settings(""),
  id,
  name: id,
  rolePrompt: "role",
  description: "description",
  parameters: [
    parameter("max_output_tokens", "8000"),
    parameter("temperature", String(temp)),
    parameter(
      "custom_option",
      '{"items":[1,true,"example"],"nested":{"count":2}}',
    ),
    parameter("disabled", "55", false),
  ],
});
afterEach(() => vi.unstubAllGlobals());
describe("execution parameter snapshots", () => {
  it.each([0, 0.7, 1.2])(
    "captures exactly sent options including temperature %s",
    async (temperature) => {
      let sent: Record<string, unknown> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init: RequestInit) => {
          sent = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              status: "completed",
              output: [{ content: [{ type: "output_text", text: "answer" }] }],
            }),
          );
        }),
      );
      const expert = makeExpert("one", temperature);
      const run = createRun("Question", "", [expert], "gpt-5.6-terra");
      await new Engine(() => {}, respond).execute(run, "dummy-key");
      const snapshot = run.results[0].attempts[0].executionParameters!;
      expect(snapshot.temperature).toBe(sent.temperature);
      expect(snapshot.temperature).toBe(temperature);
      expect(snapshot.max_output_tokens).toBe(8000);
      expect(snapshot.reasoning).toEqual({ effort: "low" });
      expect(snapshot.custom_option).toEqual({
        items: [1, true, "example"],
        nested: { count: 2 },
      });
      expect(snapshot).not.toHaveProperty("disabled");
      expect(snapshot).not.toHaveProperty("input");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.custom_option)).toBe(true);
      const html = renderToStaticMarkup(
        <ExecutionParametersReport parameters={snapshot} />,
      );
      expect(html).toContain(`>${temperature}<`);
      expect(html).toContain("custom_option");
      expect(html).toContain("&quot;count&quot;: 2");
    },
  );
  it("preserves distinct snapshots after expert edits, with no invented legacy data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "completed",
              output: [{ content: [{ type: "output_text", text: "answer" }] }],
            }),
          ),
      ),
    );
    const experts = [makeExpert("one", 0.7), makeExpert("two", 1.2)];
    const run = createRun("Q", "", experts, "gpt-5.6-terra");
    await new Engine(() => {}, respond).execute(run, "dummy-key");
    experts[0].parameters![1].value = "0";
    expect(run.results[0].attempts[0].executionParameters?.temperature).toBe(
      0.7,
    );
    expect(run.results[1].attempts[0].executionParameters?.temperature).toBe(
      1.2,
    );
    const legacy = structuredClone(run.results[0]);
    delete legacy.attempts[0].executionParameters;
    const html = renderToStaticMarkup(
      <ParticipantDetails
        run={run}
        result={legacy}
        disabled={false}
        refresh={() => {}}
        retry={() => {}}
      />,
    );
    expect(html).toContain("Parameters not recorded");
  });
  it("excludes credentials and private request content recursively", () => {
    const credential = "example-sensitive-credential";
    const captured = captureExecutionParameters(
      {
        input: "private question",
        instructions: "private role",
        model: "example-model",
        store: false,
        temperature: 0,
        api_key: credential,
        options: {
          authorization: credential,
          password: "private",
          safe: [credential, "example"],
        },
      },
      credential,
    );
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("private question");
    expect(serialized).not.toContain("private role");
    expect(serialized).not.toContain("private");
    expect(captured.options).toEqual({ safe: ["[redacted]", "example"] });
  });
  it("records no options when preflight rejects the request", async () => {
    const result = await respond("", {
      settings: settings("gpt-5.6-terra"),
      instructions: "role",
      input: "Q",
    });
    expect(result.executionParameters).toBeUndefined();
  });
});
