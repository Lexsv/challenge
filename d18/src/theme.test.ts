import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@mui/material/styles";
import { theme, palette } from "./theme";
import { toolExecutionTypeMeta } from "./tool-execution-type";

describe("shared Day 14 theme", () => {
  it("uses the approved Worker surfaces and navigation selection", () => {
    expect(palette.background.paper).toBe("#fff");
    expect(palette.background.default).toBe("#f5f8fd");
    expect(palette.action.selected).toBe("#e4eeff");
    expect(palette.primary.main).toBe("#1553d3");
    expect(theme.shape.borderRadius).toBe(8);
  });

  it.each([
    palette.background.default,
    palette.background.paper,
    palette.action.selected,
    palette.action.hover,
    palette.primary.light,
  ])("keeps body text and status labels readable on %s", (background) => {
    for (const color of [
      palette.text.primary,
      palette.text.secondary,
      palette.primary.dark,
      palette.success.main,
      palette.error.main,
      palette.warning.main,
    ]) {
      expect(
        getContrastRatio(color, background),
        `${color} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps primary buttons, keyboard focus and tool categories legible", () => {
    expect(
      getContrastRatio(palette.primary.contrastText, palette.primary.main),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      getContrastRatio(palette.primary.main, palette.action.selected),
    ).toBeGreaterThanOrEqual(3);
    for (const meta of Object.values(toolExecutionTypeMeta))
      expect(
        getContrastRatio(meta.color, meta.background),
        meta.label,
      ).toBeGreaterThanOrEqual(4.5);
  });
});
