import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExpertConfigurationChips,
  expertConfigurationLabels,
} from "./expert-configuration-chips";
import { observeAnswerOverflow, AnswerPreview } from "./answer-preview";
import { resolveExpert, settings, type Expert } from "./models";

const expert: Expert = {
  ...settings(""),
  id: "expert",
  name: "Reviewer",
  description: "Test",
  rolePrompt: "Review",
  maxTokens: 12345,
};
afterEach(() => vi.unstubAllGlobals());
describe("expert configuration chips", () => {
  it("uses execution resolution for inherited model and reasoning, retaining configured output limit", () => {
    for (const model of ["gpt-5.6-terra", "gpt-6.1-sol"]) {
      const resolved = resolveExpert(expert, model);
      const labels = expertConfigurationLabels(expert, model);
      expect(labels[0]).toBe(`Model: ${resolved.model}`);
      expect(labels[1]).toBe(
        model === "gpt-6.1-sol" ? "Reasoning: Medium" : "Reasoning: Low",
      );
      expect(labels[2]).toBe(`Output limit: ${resolved.maxTokens}`);
    }
  });
  it("reflects overrides and changes without claiming unsupported effort is active", () => {
    expect(
      expertConfigurationLabels(
        { ...expert, model: "gpt-6.1-sol", reasoning: "high", maxTokens: 2048 },
        "gpt-5.6-terra",
      ),
    ).toEqual(["Model: gpt-6.1-sol", "Reasoning: High", "Output limit: 2048"]);
    expect(
      expertConfigurationLabels(
        { ...expert, model: "gpt-6.1-sol", reasoning: "none" },
        "gpt-5.6-terra",
      )[1],
    ).toBe("Reasoning: Not supported");
    expect(
      expertConfigurationLabels(
        { ...expert, model: "custom-model", reasoning: "low" },
        "gpt-5.6-terra",
      )[1],
    ).toBe("Reasoning: Default");
    expect(
      expertConfigurationLabels(
        { ...expert, reasoning: "" },
        "gpt-5.6-terra",
      )[1],
    ).toBe("Reasoning: Default");
  });
  it("renders exactly three matching chips with wrapping enabled", () => {
    const html = renderToStaticMarkup(
      <ExpertConfigurationChips expert={expert} defaultModel="gpt-5.6-terra" />,
    );
    expect((html.match(/MuiChip-labelSmall/g) || []).length).toBe(3);
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
