import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExpertConfigurationChips,
  expertConfigurationLabels as scopedLabels,
} from "./expert-configuration-chips";
import { observeAnswerOverflow, AnswerPreview } from "./answer-preview";
import { type Expert } from "./models";
import { createProviderRegistry } from "./provider-registry";
import { settings } from "./openai-model-compat";

const expert: Expert = {
  ...settings(""),
  provider: "openai",
  id: "expert",
  name: "Reviewer",
  description: "Test",
  rolePrompt: "Review",
  maxTokens: 12345,
};
const registry = createProviderRegistry();
const expertConfigurationLabels = (value: Expert, model: string) =>
  scopedLabels(value, model, registry, "openai");
afterEach(() => vi.unstubAllGlobals());
describe("expert configuration chips", () => {
  it("shows the model without unset or default parameter badges", () => {
    for (const model of ["gpt-5.6-terra", "gpt-6.1-sol"]) {
      const labels = expertConfigurationLabels(expert, model);
      expect(labels).toEqual([`Model: ${model}`]);
    }
  });
  it("shows enabled rows once and leaves disabled, empty and system defaults hidden", () => {
    const parameters = [
      { id: "1", key: "reasoning_effort", value: "low", enabled: true },
      { id: "2", key: "temperature", value: "1.0", enabled: false },
      { id: "3", key: "top_p", value: "0.8", enabled: true },
      { id: "4", key: "reasoning_effort", value: "low", enabled: true },
      { id: "5", key: "empty", value: "", enabled: true },
    ];
    const configured = { ...expert, model: "gpt-6.1-sol", reasoning: "high", parameters };
    const before = structuredClone(configured);
    expect(expertConfigurationLabels(configured, "gpt-5.6-terra")).toEqual([
      "Model: gpt-6.1-sol", "reasoning_effort: low", "top_p: 0.8",
    ]);
    expect(configured).toEqual(before);
    expect(expertConfigurationLabels({ ...configured, parameters: [{ ...parameters[1], enabled: true }] }, "gpt-5.6-terra"))
      .toEqual(["Model: gpt-6.1-sol", "temperature: 1.0"]);
  });
  it("renders the model chip with wrapping enabled", () => {
    const html = renderToStaticMarkup(
      <ExpertConfigurationChips
        expert={expert}
        defaultModel="gpt-5.6-terra"
        registry={registry}
      />,
    );
    expect((html.match(/MuiChip-labelSmall/g) || []).length).toBe(1);
    expect(html).toContain("flex-wrap:wrap");
    expect(html).toContain("overflow-wrap:anywhere");
  });
});
describe("measured answer overflow", () => {
  it("measures actual content on mount and resize, and disconnects observation", () => {
    let resize: () => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const element = { scrollHeight: 84, clientHeight: 84 } as HTMLElement;
    const changed = vi.fn();
    const cleanup = observeAnswerOverflow(element, changed);
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(observe).toHaveBeenCalledWith(element);
    Object.assign(element, { scrollHeight: 210 });
    resize();
    expect(changed).toHaveBeenLastCalledWith(true);
    Object.assign(element, { clientHeight: 210 });
    resize();
    expect(changed).toHaveBeenLastCalledWith(false);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("retains complete plain text and a four-line scroll area without assuming overflow before layout", () => {
    const text = "Selectable **literal syntax**\n".repeat(30);
    const html = renderToStaticMarkup(
      <AnswerPreview text={text} expertName="Reviewer" onMore={() => {}} />,
    );
    expect(html).toContain(text);
    expect(html).toContain("max-height:6em");
    expect(html).toContain("scrollbar-color:");
    expect(html).not.toContain(">More</button>");
  });
});
