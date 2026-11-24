import { describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./legacy-engine";
import { type Expert } from "./models";
import { settings } from "./openai-model-compat";
import { createProviderRegistry, ProviderRegistry } from "./provider-registry";
import type { Request } from "./openai";

describe("independent evaluator", () => {
  it("snapshots a separate evaluator and reuses its provider, key and parameters on retry", async () => {
    const participant = vi
      .fn()
      .mockResolvedValue({ status: "succeeded", text: "answer", ms: 1 });
    const evaluator = vi
      .fn()
      .mockImplementationOnce(async () => ({
        status: "failed",
        text: "",
        ms: 1,
      }))
      .mockImplementationOnce(async (_key: string, request: Request) => ({
        status: "succeeded",
        text: JSON.stringify({
          evaluations: JSON.parse(request.input).answers.map(
            (a: { resultId: string }) => ({
              resultId: a.resultId,
              verdict: "correct",
              explanation: "yes",
            }),
          ),
        }),
        ms: 1,
      }));
    const defaultRegistry = createProviderRegistry(participant);
    const registry = new ProviderRegistry([
      defaultRegistry.get("openai")!,
      {
        id: "opencode-go",
        catalog: () => ["other-model"],
        capabilities: () => ({
          structuredOutput: true,
          maxOutputTokens: 1000,
          supportedParameters: { temperature: true },
        }),
        validate: () => undefined,
        execute: evaluator,
      },
    ]);
    const expert: Expert = {
      ...settings("gpt-5.6-terra"),
      id: "x",
      name: "x",
      description: "",
      rolePrompt: "role",
    };
    const evaluatorSettings = {
      provider: "opencode-go",
      model: "other-model",
      maxTokens: 100,
      parameters: [
        { id: "p", enabled: true, key: "temperature", value: "0.7" },
      ],
    };
    const run = createRun(
      "question",
      "reference",
      [expert],
      "gpt-5.6-terra",
      "openai",
      registry,
      evaluatorSettings,
    );
    evaluatorSettings.parameters[0].value = "0.1";
    const engine = new Engine(() => {}, participant, {}, registry);
    const keys = (id: string) =>
      id === "openai" ? "openai-dummy" : "go-dummy";
    await engine.execute(run, keys);
    expect(run.evaluationStatus).toBe("failed");
    await engine.execute(run, keys, undefined, true);
    expect(run.evaluationStatus).toBe("completed");
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(evaluator.mock.calls.map((call) => call[0])).toEqual([
      "go-dummy",
      "go-dummy",
    ]);
    expect(evaluator.mock.calls[1][1].settings.parameters[0].value).toBe("0.7");
    expect(participant.mock.calls[0][0]).toBe("openai-dummy");
    expect(run.snapshot.evaluator.model).toBe("other-model");
    expect(JSON.stringify(run.snapshot)).not.toContain("dummy");
  });
  it("rejects unknown evaluator providers and preserves OpenAI defaults", () => {
    const expert: Expert = {
      ...settings("gpt-5.6-terra"),
      id: "x",
      name: "x",
      description: "",
      rolePrompt: "role",
    };
    expect(
      createRun("q", "a", [expert], "gpt-5.6-terra").snapshot.evaluator
        .provider,
    ).toBe("openai");
    expect(() =>
      createRun(
        "q",
        "a",
        [expert],
        "gpt-5.6-terra",
        "openai",
        createProviderRegistry(),
        { provider: "unknown", model: "x", maxTokens: 100 },
      ),
    ).toThrow();
  });
});

it("requires explicit non-OpenAI evaluator settings rather than using OpenAI defaults", () => {
  const expert: Expert = {
    ...settings("gpt-5.6-terra"),
    id: "x",
    name: "x",
    description: "",
    rolePrompt: "role",
  };
  expect(() =>
    createRun("q", "a", [expert], "gpt-5.6-terra", "opencode-go"),
  ).toThrow(/evaluator configuration is required/i);
});

it("reports provider validation reason with context, sanitizes configured secrets, and does not dispatch", () => {
  const execute = vi.fn();
  const registry = new ProviderRegistry([
    {
      id: "custom",
      catalog: () => ["bad-model"],
      capabilities: () => ({
        structuredOutput: true,
        maxOutputTokens: 1000,
        supportedParameters: {},
      }),
      validate: () => "Unsupported option: api_key=private-value",
      execute,
    },
  ]);
  const expert: Expert = {
    provider: "custom",
    model: "bad-model",
    maxTokens: 100,
    id: "x",
    name: "x",
    description: "d",
    rolePrompt: "r",
    parameters: [
      { id: "p", enabled: true, key: "test", value: "private-value" },
    ],
  };
  const evaluator = { provider: "custom", model: "bad-model", maxTokens: 100 };
  let message = "";
  try {
    createRun("q", "a", [expert], "bad-model", "custom", registry, evaluator);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("custom");
  expect(message).toContain("bad-model");
  expect(message).toContain("Unsupported option");
  expect(message).not.toContain("private-value");
  expect(execute).not.toHaveBeenCalled();
});
