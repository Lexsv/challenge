import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialParameters,
  newParameter,
  parameterPayload,
  parseParameterValue,
  validateParameters,
} from "./api-parameters";
import { createRun } from "./engine";
import { duplicateExpert } from "./duplicate-expert";
import { resolveExpert, settings, type Expert } from "./models";
import { respond } from "./openai";
const row = (key: string, value: string, enabled = true) => ({
  id: crypto.randomUUID(),
  key,
  value,
  enabled,
});
const expert: Expert = {
  ...settings(""),
  id: "id",
  name: "Expert",
  description: "Description",
  rolePrompt: "Role",
  maxTokens: 1024,
};
afterEach(() => vi.unstubAllGlobals());
describe("API parameters", () => {
  it("creates disabled empty rows that only validate and enter requests when enabled", () => {
    const fresh = newParameter();
    expect(fresh).toMatchObject({ enabled: false, key: "", value: "" });
    expect(newParameter().id).not.toBe(fresh.id);
    const existing = row("temperature", "0.7");
    const rows = [existing, fresh];
    expect(validateParameters(rows)).toBeUndefined();
    expect(parameterPayload(rows)).toEqual({ temperature: 0.7 });
    const enabled = { ...fresh, enabled: true };
    expect(validateParameters([existing, enabled])).toMatch(/need a key/);
    const edited = { ...enabled, key: "top_p", value: "0.9" };
    expect(parameterPayload([existing, edited])).toEqual({
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(existing).toMatchObject({
      enabled: true,
      key: "temperature",
      value: "0.7",
    });
  });
  it("parses numbers, booleans, structured JSON and ordinary text", () => {
    for (const n of [0, 0.7, 1.2, 8192])
      expect(parseParameterValue(String(n))).toBe(n);
    expect(parseParameterValue("true")).toBe(true);
    expect(parseParameterValue("false")).toBe(false);
    expect(parseParameterValue('["END"]')).toEqual(["END"]);
    expect(parseParameterValue('{"type":"json_object"}')).toEqual({
      type: "json_object",
    });
    expect(parseParameterValue("hello")).toBe("hello");
    expect(() => parseParameterValue('{"broken"')).toThrow();
    expect(() => parseParameterValue('["broken"')).toThrow();
  });
  it("validates active rows while preserving disabled and arbitrary keys", () => {
    expect(validateParameters([row("", "1")])).toMatch(/need a key/);
    expect(validateParameters([row("x", "1"), row("x", "2")])).toMatch(
      /Duplicate/,
    );
    expect(validateParameters([row("model", "example")])).toMatch(/managed/);
    expect(validateParameters([row("x", "{broken")])).toMatch(/Invalid JSON/);
    expect(
      parameterPayload([
        row("x", "1"),
        row("x", "{broken", false),
        row("custom", "hello"),
      ]),
    ).toEqual({ x: 1, custom: "hello" });
  });
  it("migrates legacy values, copies independent arrays, and captures immutable snapshots", () => {
    const migrated = resolveExpert(expert, "gpt-5.6-terra");
    expect(
      migrated.parameters?.map((p) => [p.key, p.value, p.enabled]),
    ).toEqual([
      ["max_output_tokens", "1024", true],
      ["temperature", "0", false],
    ]);
    const rows = initialParameters(1024);
    rows.push(row("custom", "1", false));
    const original = { ...expert, parameters: rows };
    const run = createRun("Q", "R", [original], "gpt-5.6-terra");
    const copy = duplicateExpert([original], original.id)[1];
    copy.parameters![0].value = "2048";
    original.parameters[0].value = "4096";
    expect(run.results[0].expert.parameters![0].value).toBe("1024");
    expect(copy.parameters![0].value).toBe("2048");
    expect(copy.parameters![2].enabled).toBe(false);
  });
  it.each([0, 0.7, 1.2])(
    "serializes enabled temperature %s and excludes disabled values",
    async (temperature) => {
      let body: Record<string, unknown> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              status: "completed",
              output: [{ content: [{ type: "output_text", text: "answer" }] }],
            }),
          );
        }),
      );
      const parameters = [
        row("max_output_tokens", "1024"),
        row("temperature", String(temperature)),
        row("custom_api_option", '{"foo":true}'),
        row("disabled", "123", false),
      ];
      await respond("dummy-key", {
        settings: { ...settings("gpt-5.6-terra"), parameters },
        input: "question",
        instructions: "role",
      });
      expect(body.temperature).toBe(temperature);
      expect(body.max_output_tokens).toBe(1024);
      expect(body.custom_api_option).toEqual({ foo: true });
      expect(body).not.toHaveProperty("disabled");
    },
  );
  it("shows provider rejection with the supplied credential redacted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Unsupported parameter temperature for dummy-key",
              },
            }),
            { status: 400 },
          ),
      ),
    );
    const result = await respond("dummy-key", {
      settings: {
        ...settings("gpt-5.6-terra"),
        parameters: [row("temperature", "0")],
      },
      input: "Q",
      instructions: "role",
    });
    expect(result.error).toContain("Unsupported parameter temperature");
    expect(result.error).not.toContain("dummy-key");
  });
});
