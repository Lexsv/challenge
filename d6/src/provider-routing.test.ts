import { describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./legacy-engine";
import { type Expert } from "./models";
import { settings } from "./openai-model-compat";
import { ProviderRegistry, createProviderRegistry } from "./provider-registry";

const expert = (id: string, provider?: string): Expert => ({
  ...settings("gpt-5.6-terra"),
  id,
  name: id,
  description: "",
  rolePrompt: "private prompt",
  provider: provider ?? "openai",
});
const ok = { status: "succeeded" as const, text: "answer", ms: 1 };
describe("provider-aware execution", () => {
  it("isolates credentials for mixed runs and retains provider on retry", async () => {
    const openai = vi.fn().mockResolvedValue(ok);
    const opencode = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", text: "", ms: 1 })
      .mockResolvedValueOnce(ok);
    const team = [
      expert("legacy"),
      { ...expert("go", "opencode-go"), model: "go-model" },
    ];
    const registry = createProviderRegistry(openai);
    const providers = new ProviderRegistry([
      registry.get("openai")!,
      {
        id: "opencode-go",
        catalog: () => ["go-model"],
        capabilities: () => ({
          structuredOutput: true,
          maxOutputTokens: 128000,
          supportedParameters: {},
        }),
        validate: () => undefined,
        execute: opencode,
      },
    ]);
    const run = createRun(
      "question",
      "",
      team,
      "gpt-5.6-terra",
      "openai",
      providers,
    );
    team[1].provider = "openai";
    const engine = new Engine(() => {}, openai, {}, providers);
    const credentials = (provider: string) =>
      provider === "openai" ? "openai-dummy" : "go-dummy";
    await engine.execute(run, credentials);
    await engine.execute(run, credentials, 1);
    expect(run.snapshot.experts.map((e) => e.provider)).toEqual([
      "openai",
      "opencode-go",
    ]);
    expect(openai).toHaveBeenCalledTimes(1);
    expect(openai.mock.calls[0][0]).toBe("openai-dummy");
    expect(opencode).toHaveBeenCalledTimes(2);
    expect(opencode.mock.calls.map((call) => call[1].settings.model)).toEqual([
      "go-model",
      "go-model",
    ]);
    expect(openai.mock.calls[0][1].settings.model).toBe("gpt-5.6-terra");
    expect(opencode.mock.calls.map((call) => call[0])).toEqual([
      "go-dummy",
      "go-dummy",
    ]);
  });
  it("rejects unsupported providers without sending the OpenAI key", async () => {
    const openai = vi.fn().mockResolvedValue(ok);
    expect(() =>
      createRun("question", "", [expert("x", "unknown")], "gpt-5.6-terra"),
    ).toThrow();
    expect(openai).not.toHaveBeenCalled();
  });
});

it("rejects missing provider and cross-provider model inheritance before dispatch", () => {
  const registry = createProviderRegistry();
  expect(() =>
    createRun(
      "q",
      "",
      [{ ...expert("one"), provider: undefined }],
      "gpt-5.6-terra",
      "openai",
      registry,
    ),
  ).toThrow(/provider identity/i);
  expect(() =>
    createRun(
      "q",
      "",
      [{ ...expert("one"), provider: "opencode-go", model: "" }],
      "gpt-5.6-terra",
      "openai",
      registry,
    ),
  ).toThrow(/model configured/i);
});
