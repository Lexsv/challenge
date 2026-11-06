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
