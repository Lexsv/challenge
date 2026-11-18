import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createProviderRegistry } from "./provider-registry";
import { consoleModelSelectable } from "./opencode-console-verification";
import { ModelField } from "./main";
import { parseModels } from "./opencode-catalog";

afterEach(() => vi.unstubAllGlobals());
describe("Console model selection", () => {
  it("excludes known free and unsupported models without excluding untested paid models", () => {
    expect(consoleModelSelectable("beam-free")).toBe(false);
    expect(consoleModelSelectable("big-pickle")).toBe(false);
    expect(consoleModelSelectable("claude-opus-5-5")).toBe(false);
    expect(consoleModelSelectable("glm-5.3-flash")).toBe(true);
    expect(consoleModelSelectable("glm-5.3-flash", { disabled: true })).toBe(false);
    expect(consoleModelSelectable("glm-5.3-flash", { available: false })).toBe(false);
  });
  it("uses explicit availability metadata after refresh and preserves selected settings", async () => {
    const selected = { provider: "opencode-console", model: "kimi-k3", parameters: [] };
    const before = structuredClone(selected);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "kimi-k3", disabled: true }, { id: "glm-5.3-flash", available: false }, { id: "gpt-5.5", available: true }] }) });
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    expect(fetcher).not.toHaveBeenCalled();
    expect(registry.modelOptionsFor("opencode-console")).toContain("kimi-k3");
    await registry.get("opencode-console")!.discover!();
    const options = registry.modelOptionsFor("opencode-console");
    expect(options).not.toContain("kimi-k3");
    expect(options).not.toContain("glm-5.3-flash");
    expect(options).toContain("gpt-5.5");
    expect(selected).toEqual(before);
    expect(renderToStaticMarkup(<ModelField label="Model" value={selected.model} onChange={() => { throw Error("should not change"); }} providerId={selected.provider} registry={registry} />)).toContain("previously selected; unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains only explicit Boolean availability fields", () => {
    expect(parseModels({ data: [{ id: "kimi-k3", disabled: true }, { id: "gpt-5.5", available: false }, { id: "glm-5.3", disabled: "true" }] })).toEqual([
      { id: "kimi-k3", name: "kimi-k3", disabled: true },
      { id: "gpt-5.5", name: "gpt-5.5", available: false },
      { id: "glm-5.3", name: "glm-5.3" },
    ]);
  });
});
