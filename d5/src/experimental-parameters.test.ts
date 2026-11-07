import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./engine";
import { createProviderRegistry } from "./provider-registry";
import { settings } from "./openai-model-compat";
import { parameterSupport } from "./provider-registry";

afterEach(() => vi.unstubAllGlobals());
describe("experimental OpenAI parameters", () => {
  it("forwards experimental reasoning and temperature without capability substitutions", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const config = { ...settings("gpt-5.6-terra"), reasoning: undefined };
    const parameters = [
      { id: "r", enabled: true, key: "reasoning_effort", value: "experimental" },
      { id: "t", enabled: true, key: "temperature", value: "2.5" },
      { id: "d", enabled: false, key: "unused", value: "unchanged" },
    ];
    const expert = { ...config, id: "x", name: "x", description: "d", rolePrompt: "role", parameters };
    const run = createRun("question", "", [expert], config.model, "openai", registry, config, "current-v1");
    await new Engine(() => {}, registry).execute(run, () => "dummy");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: "experimental" });
    expect(body.temperature).toBe(2.5);
    expect(body).not.toHaveProperty("unused");
    expect(run.snapshot.experts[0].parameters).toEqual(parameters);
  });
  it("sends enabled temperature without changing reasoning, model, or disabled values", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-5.6-terra",
          output: [{ content: [{ type: "output_text", text: "answer" }] }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const expert = {
      ...settings("gpt-5.6-terra"),
      id: "x",
      name: "x",
      description: "d",
      rolePrompt: "role",
      parameters: [
        { id: "t", enabled: true, key: "temperature", value: "0.7" },
        { id: "d", enabled: false, key: "top_p", value: "0.4" },
      ],
    };
    const evaluator = { ...settings("gpt-5.6-terra"), provider: "openai" };
    const run = createRun(
      "question",
      "",
      [expert],
      evaluator.model,
      "openai",
      registry,
      evaluator,
      "current-v1",
    );
    await new Engine(() => {}, registry).execute(run, (id) =>
      id === "openai" ? "dummy-key" : "",
    );
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "gpt-5.6-terra",
      temperature: 0.7,
      reasoning: { effort: "low" },
    });
    expect(body).not.toHaveProperty("top_p");
    expect(run.snapshot.experts[0].provider).toBe("openai");
    expect(run.results[0].attempts[0].status).toBe("succeeded");
    expect(
      parameterSupport(
        registry.get("openai")!.capabilities(evaluator.model)
          ?.supportedParameters,
        "temperature",
      ),
    ).toBe("unknown");
  });
  it("surfaces a sanitized provider rejection in the result without retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "temperature rejected for dummy-key" },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const config = { ...settings("gpt-5.6-terra"), provider: "openai" };
    const expert = {
      ...config,
      id: "x",
      name: "x",
      description: "d",
      rolePrompt: "role",
      parameters: [
        { id: "t", enabled: true, key: "temperature", value: "0.7" },
      ],
    };
    const run = createRun(
      "question",
      "",
      [expert],
      config.model,
      "openai",
      registry,
      config,
      "current-v1",
    );
    await new Engine(() => {}, registry).execute(run, () => "dummy-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(run.results[0].attempts[0].status).toBe("failed");
    expect(run.results[0].attempts[0].error).toContain("temperature rejected");
    expect(run.results[0].attempts[0].error).not.toContain("dummy-key");
  });
});

it("hides unspecified reasoning when the adapter omits it despite a catalog default", async () => {
  const { expertConfigurationLabels } =
    await import("./expert-configuration-chips");
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const registry = createProviderRegistry();
  const config = { ...settings("gpt-5.6-terra"), reasoning: undefined };
  const expert = {
    ...config,
    id: "x",
    name: "x",
    description: "d",
    rolePrompt: "r",
  };
  expect(
    expertConfigurationLabels(expert, config.model, registry, "openai"),
  ).toEqual([`Model: ${config.model}`]);
  const run = createRun(
    "q",
    "",
    [expert],
    config.model,
    "openai",
    registry,
    config,
    "current-v1",
  );
  await new Engine(() => {}, registry).execute(run, () => "dummy");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty(
    "reasoning",
  );
  expect(run.snapshot.experts[0].reasoning).toBeUndefined();
});
