import { afterEach, expect, it, vi } from "vitest";
import { createProviderRegistry } from "./provider-registry";
import { createRun, Engine } from "./engine";
import { settings } from "./openai-model-compat";

afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  "forwards unknown parameters and preserves failure details (failure: %s)",
  async (failure) => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/models"))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "example-model",
                capabilities: {
                  structured_output: true,
                  top_p: false,
                },
                limit: { output: 1024 },
              },
            ],
          }),
          { status: 200 },
        );
      return failure
        ? new Response(
            JSON.stringify({
              error: {
                message: "experimental field rejected; key dummy-opencode",
              },
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              model: "example-model",
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            }),
            { status: 200 },
          );
    });
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const provider = registry.get("opencode-go")!;
    await provider.discover!();
    const params = [
      {
        id: "a",
        key: "experimental_option",
        value: '{"value":2}',
        enabled: true,
      },
      { id: "b", key: "temperature", value: "0.4", enabled: false },
      { id: "c", key: "top_p", value: "0.8", enabled: true },
    ];
    const expert = {
      id: "x",
      name: "x",
      description: "d",
      rolePrompt: "role",
      provider: "opencode-go",
      model: "example-model",
      maxTokens: 100,
      parameters: params,
    };
    const evaluator = settings("gpt-5.6-terra");
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
    const snapshot = JSON.stringify(run.snapshot);
    await new Engine(() => {}, registry).execute(run, (id) =>
      id === "opencode-go" ? "dummy-opencode" : "",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.experimental_option).toEqual({ value: 2 });
    expect(body.top_p).toBe(0.8);
    expect(body).not.toHaveProperty("temperature");
    expect(body.model).toBe("example-model");
    expect(body.max_completion_tokens).toBe(100);
    expect(JSON.stringify(run.snapshot)).toBe(snapshot);
    expect(run.results[0].attempts[0].status).toBe(
      failure ? "failed" : "succeeded",
    );
    if (failure) {
      expect(run.results[0].attempts[0].error).toContain(
        "experimental field rejected",
      );
      expect(run.results[0].attempts[0].error).not.toContain("dummy-opencode");
    }
  },
);

it("retains successful answers and associates failures with their own captured participant", async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: ["kimi-k3", "glm-5.3-flash"].map(id => ({ id, limit: { output: 1024 } })) }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    return body.model === "kimi-k3"
      ? new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: "retained answer" }, finish_reason: "stop" }] }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: "Access restricted" } }), { status: 403 });
  });
  vi.stubGlobal("fetch", fetcher);
  const registry = createProviderRegistry();
  await registry.get("opencode-console")!.discover!();
  const expert = (id: string, model: string) => ({ id, name: id, description: "", rolePrompt: "role", provider: "opencode-console", model, maxTokens: 100, parameters: [] });
  const evaluator = settings("gpt-5.6-terra");
  const run = createRun("question", "", [expert("one", "kimi-k3"), expert("two", "glm-5.3-flash")], evaluator.model, "openai", registry, evaluator, "current-v1");
  await new Engine(() => {}, registry).execute(run, () => "dummy-key");
  expect(run.results[0].attempts[0]).toMatchObject({ status: "succeeded", text: "retained answer" });
  expect(run.results[1].expert).toMatchObject({ provider: "opencode-console", model: "glm-5.3-flash" });
  expect(run.results[1].attempts[0].failure).toMatchObject({ httpStatus: 403, category: "permission", providerMessage: "Access restricted" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
