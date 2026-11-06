import { describe, expect, it, vi } from "vitest";
import { openCodeAdapter } from "./opencode-adapter";

describe("OpenCode request boundary", () => {
  it("routes to the documented Go endpoint and keeps disabled parameters out", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "test",
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }),
    });
    const result = await openCodeAdapter("go", fetcher)("dummy-key", {
      settings: {
        model: "test",
        maxTokens: 128,
        parameters: [
          { id: "1", enabled: true, key: "temperature", value: "0.7" },
          { id: "2", enabled: false, key: "top_p", value: "0.1" },
        ],
      },
      instructions: "role",
      input: "question",
    });
    expect(result.status).toBe("succeeded");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://opencode.ai/inference/go/openai/v1/chat/completions",
    );
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "test",
      temperature: 0.7,
    });
    expect(JSON.parse(init.body)).not.toHaveProperty("top_p");
    expect(JSON.stringify(result)).not.toContain("dummy-key");
  });
  it("does not expose provider errors or credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await openCodeAdapter("console", fetcher)("dummy-key", {
      settings: { model: "test", maxTokens: 128 },
      instructions: "",
      input: "",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("401");
    expect(JSON.stringify(result)).not.toContain("dummy-key");
  });
});

it("maps the output limit in OpenCode requests and rejects managed fields", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }),
  });
  const adapter = openCodeAdapter("go", fetcher);
  const config = {
    model: "test",
    maxTokens: 128,
    parameters: [
      { id: "x", enabled: true, key: "max_output_tokens", value: "64" },
    ],
  };
  await adapter("dummy", { settings: config, instructions: "", input: "" });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.max_completion_tokens).toBe(64);
  expect(body).not.toHaveProperty("max_output_tokens");
  const failed = await adapter("dummy", {
    settings: {
      ...config,
      parameters: [{ id: "x", enabled: true, key: "messages", value: "[]" }],
    },
    instructions: "",
    input: "",
  });
  expect(failed.status).toBe("failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  [
    JSON.stringify({
      error: {
        message:
          'Invalid option; authorization: Bearer secret-value; api_key="another-secret"; dummy-key',
      },
    }),
    "Invalid option",
  ],
  ["not json", "Check account access"],
  ["", "Check account access"],
  [JSON.stringify({ error: { code: "bad" } }), "Check account access"],
])(
  "sanitizes provider explanations and handles malformed responses",
  async (body, expected) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 400 }));
    const result = await openCodeAdapter("go", fetcher)("dummy-key", {
      settings: { model: "test", maxTokens: 128 },
      instructions: "",
      input: "",
    });
    expect(result.error).toContain("(400)");
    expect(result.error).toContain(expected);
    expect(result.error).not.toContain("dummy-key");
    expect(result.error).not.toContain("secret-value");
    expect(result.error).not.toContain("another-secret");
  },
);
