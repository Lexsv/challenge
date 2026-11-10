import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { expertEditDraft, generationModelFor, retryCredentialReason } from "./interaction-safety";
import { ParticipantDetails, RunView } from "./results";
import { createRun } from "./legacy-engine";
import { settings } from "./openai-model-compat";
import type { Expert } from "./models";
import { generateWithProvider, validateExperts } from "./generation";
import { ProviderRegistry } from "./provider-registry";
import { vi } from "vitest";

const expert: Expert = {
  ...settings("gpt-5.6-terra"),
  id: "x",
  name: "Expert",
  description: "Description",
  rolePrompt: "Prompt",
};
describe("expert editor and retry safety", () => {
  it("preserves absent parameters when editing unrelated fields and copies configured rows independently", () => {
    const draft = expertEditDraft(expert);
    expect(draft.parameters).toBeUndefined();
    draft.name = "Changed";
    expect(draft.parameters).toBeUndefined();
    const rows = [
      { id: "p", key: "temperature", value: "0.7", enabled: false },
    ];
    const configured = { ...expert, parameters: rows };
    const edit = expertEditDraft(configured);
    edit.parameters![0].value = "1.2";
    expect(rows[0].value).toBe("0.7");
    expect(edit.parameters![0]).toMatchObject({ value: "1.2", enabled: false });
  });
  it("checks credentials for the captured provider without fallback", () => {
    const keys = (id: string) => (id === "opencode-go" ? "dummy" : "");
    expect(retryCredentialReason("opencode-go", keys)).toBeUndefined();
    expect(retryCredentialReason("openai", keys)).toContain("openai");
    expect(retryCredentialReason(undefined, keys)).toContain(
      "captured provider",
    );
  });
  it("renders a provider-specific reason only for a missing participant or evaluator key", () => {
    const run = createRun("question", "answer", [expert], "gpt-5.6-terra");
    run.results[0].attempts.push({
      id: "a",
      status: "failed",
      text: "",
      ms: 1,
    });
    run.evaluationStatus = "failed";
    const missing = renderToStaticMarkup(
      <ParticipantDetails
        run={run}
        result={run.results[0]}
        disabled={false}
        retryReason="Add the API key for provider opencode-go in Settings before retrying."
        refresh={() => {}}
        retry={() => {}}
      />,
    );
    expect(missing).toContain("provider opencode-go");
    expect(missing).toMatch(/disabled=""/);
    const evaluator = renderToStaticMarkup(
      <RunView
        run={run}
        disabled={false}
        credential={() => ""}
        refresh={() => {}}
        retry={() => {}}
        retryEvaluation={() => {}}
      />,
    );
    expect(evaluator).toContain("provider openai");
  });
});

describe("OpenAI Settings model selection", () => {
  it("keeps an OpenCode generation pair and its expert parameters when the OpenAI selection changes", async () => {
    const execute = vi.fn().mockResolvedValue({ status: "succeeded", text: "{}", ms: 1 });
    const registry = new ProviderRegistry([{
      id: "opencode-go",
      catalog: () => ["go-model"],
      capabilities: () => ({ structuredOutput: true, maxOutputTokens: 1000, supportedParameters: {} }),
      validate: () => undefined,
      execute,
    }]);
    const configuration = {
      provider: "opencode-go",
      model: "go-model",
      maxTokens: 512,
      parameters: [
        { id: "p", enabled: true, key: "temperature", value: "0.7" },
        { id: "q", enabled: false, key: "top_p", value: "0.4" },
      ],
    };
    const original = structuredClone(configuration);
    const expert = validateExperts(JSON.stringify({ experts: [{ name: "A", roleLabel: "Role", description: "D", rolePrompt: "P" }] }), true, configuration)[0];
    const originalExpert = structuredClone(expert);
    let openAISelection = "gpt-5.6-terra";
    openAISelection = "gpt-6.1-sol";
    const generation = { ...configuration, model: generationModelFor(configuration.provider, openAISelection, configuration) };
    await generateWithProvider(registry, generation, (id) => id === "opencode-go" ? "go-dummy" : "", "team", false);
    expect(execute).toHaveBeenCalledWith("go-dummy", expect.objectContaining({ settings: original }));
    expect(configuration).toEqual(original);
    expect(expert).toEqual(originalExpert);
    expect(generation.parameters).toEqual(original.parameters);
  });

  it("uses the changed OpenAI selection for explicitly OpenAI generation", async () => {
    const execute = vi.fn().mockResolvedValue({ status: "succeeded", text: "{}", ms: 1 });
    const registry = new ProviderRegistry([{
      id: "openai",
      catalog: () => ["gpt-5.6-terra", "gpt-6.1-sol"],
      capabilities: () => ({ structuredOutput: true, maxOutputTokens: 1000, supportedParameters: {} }),
      validate: () => undefined,
      execute,
    }]);
    const configuration = { provider: "openai", model: "gpt-5.6-terra", maxTokens: 100, parameters: [] };
    const model = generationModelFor(configuration.provider, "gpt-6.1-sol", configuration);
    await generateWithProvider(registry, { ...configuration, model }, () => "openai-dummy", "team", false);
    expect(execute).toHaveBeenCalledWith("openai-dummy", expect.objectContaining({ settings: { ...configuration, model: "gpt-6.1-sol" } }));
    expect(configuration.model).toBe("gpt-5.6-terra");
    expect(generationModelFor("", "gpt-6.1-sol", undefined)).toBe("");
  });
});

it("retries a captured OpenCode participant with only its own credential", async () => {
  const { createRun: createCoreRun, Engine } = await import("./engine");
  const { ProviderRegistry } = await import("./provider-registry");
  const { vi } = await import("vitest");
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ status: "failed", text: "", ms: 1 })
    .mockResolvedValueOnce({ status: "succeeded", text: "ok", ms: 1 });
  const provider = {
    id: "opencode-go",
    catalog: () => ["model"],
    capabilities: () => ({
      structuredOutput: true,
      maxOutputTokens: 1000,
      supportedParameters: {},
    }),
    validate: () => undefined,
    execute,
  };
  const registry = new ProviderRegistry([provider]);
  const goExpert: Expert = {
    ...expert,
    provider: "opencode-go",
    model: "model",
    maxTokens: 100,
  };
  const run = createCoreRun(
    "q",
    "",
    [goExpert],
    "model",
    "opencode-go",
    registry,
    { provider: "opencode-go", model: "model", maxTokens: 100 },
    "current-v1",
  );
  const key = (id: string) => (id === "opencode-go" ? "go-dummy" : "");
  const engine = new Engine(() => {}, registry);
  await engine.execute(run, key);
  expect(
    retryCredentialReason(run.results[0].expert.provider, key),
  ).toBeUndefined();
  await engine.execute(run, key, 0);
  expect(execute.mock.calls.map((call) => call[0])).toEqual([
    "go-dummy",
    "go-dummy",
  ]);
  expect(run.results[0].attempts.at(-1)?.status).toBe("succeeded");
  expect(run.snapshot.validationPolicy).toBe("current-v1");
});
