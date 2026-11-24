import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuiltinConnectionSettings, verificationError, verifyOpenCode } from "./builtin-connection-settings";
import { createProviderRegistry, ProviderRegistry } from "./provider-registry";
import { ConnectionController } from "./connection";
import { INFERENCE_ENDPOINTS } from "./opencode-adapter";
import { catalog, MODEL_ENDPOINTS } from "./opencode-catalog";

describe("built-in connection settings", () => {
  it("keeps the OpenAI controller in memory without reading or writing storage", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const controller = new ConnectionController(() => storage, true);
    controller.updateKey("dummy-openai");
    expect(controller.getKey()).toBe("dummy-openai");
    controller.forget();
    expect(controller.getKey()).toBe("");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("presents two connections without making a request or changing catalog metadata", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const before = structuredClone(catalog);
    const registry = createProviderRegistry();
    const markup = renderToStaticMarkup(<BuiltinConnectionSettings registry={registry} keys={{ "opencode-console": "dummy-console", "opencode-go": "dummy-go" }} setKey={() => {}} />);
    expect(markup).toContain("OpenCode connection");
    expect(markup).toContain("Discover capabilities");
    expect(markup).toContain("Verify connection");
    expect(markup).toContain('type="password"');
    expect(registry.get("opencode-console")).not.toBe(registry.get("opencode-go"));
    expect(registry.modelOptionsFor("opencode-console")).toContain("gpt-6-astra");
    expect(registry.modelOptionsFor("opencode-go")).not.toContain("gpt-6-astra");
    expect(catalog).toEqual(before);
    expect(INFERENCE_ENDPOINTS.console).not.toEqual(INFERENCE_ENDPOINTS.go);
    expect(MODEL_ENDPOINTS.console).not.toEqual(MODEL_ENDPOINTS.go);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it("verifies only the explicitly requested connection with its own key", async () => {
    const consoleExecute = vi.fn().mockResolvedValue({ status: "succeeded", text: "ok", ms: 1 });
    const goExecute = vi.fn().mockResolvedValue({ status: "failed", text: "", ms: 1 });
    const provider = (id: string, execute: typeof consoleExecute) => ({ id, catalog: () => ["model"], capabilities: () => ({ structuredOutput: true, maxOutputTokens: 1000, supportedParameters: {} }), validate: () => undefined, execute });
    const registry = new ProviderRegistry([provider("opencode-console", consoleExecute), provider("opencode-go", goExecute)]);
    expect(consoleExecute).not.toHaveBeenCalled();
    expect(goExecute).not.toHaveBeenCalled();
    expect(await verifyOpenCode(registry, "opencode-go", "dummy-go", "model")).toMatch(/failed/);
    expect(goExecute).toHaveBeenCalledWith("dummy-go", expect.objectContaining({ settings: expect.objectContaining({ provider: "opencode-go", model: "model" }) }));
    expect(consoleExecute).not.toHaveBeenCalled();
    expect(await verifyOpenCode(registry, "opencode-console", "dummy-console", "model")).toBe("Verified");
    expect(consoleExecute).toHaveBeenCalledWith("dummy-console", expect.anything());
  });

  it("sanitizes verification errors while preserving a useful explanation", () => {
    const message = verificationError("HTTP 400: invalid option; key=dummy-secret-value", "dummy-secret-value");
    expect(message).toContain("HTTP 400");
    expect(message).not.toContain("dummy-secret-value");
    expect(verificationError(undefined, "dummy")).toMatch(/Verification failed/);
  });
});
