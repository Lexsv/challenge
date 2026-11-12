import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@mui/material/styles";
import { theme } from "./theme";
import { vintagePalette as p } from "./vintage-palette";
import { toolExecutionTypeMeta } from "./tool-execution-type";

describe("Day 8 vintage pink and blue theme", () => {
  it("uses near-white surfaces with pink accents and blue selections", () => {
    expect(theme.palette.background.default).toBe(p.surface);
    expect(theme.palette.secondary.main).toBe(p.pink);
    expect(theme.palette.action.selected).toBe(p.blueSelected);
    expect(p.pink).not.toBe(p.blueSelected);
  });
  it.each([p.surface, p.paper, p.pink, p.bluePale, p.blueSelected])(
    "keeps body and status labels readable on %s",
    (background) => {
      for (const color of [p.text, p.muted, p.success, p.error, p.warning]) {
        expect(
          getContrastRatio(color, background),
          `${color} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
  it("keeps accent controls, tool labels and focus outlines readable", () => {
    for (const background of [p.blue, p.blueHover, p.blueSelected])
      expect(getContrastRatio(p.blueInk, background)).toBeGreaterThanOrEqual(
        4.5,
      );
    expect(getContrastRatio(p.text, p.pink)).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio(p.blueInk, p.surface)).toBeGreaterThanOrEqual(4.5);
    for (const meta of Object.values(toolExecutionTypeMeta))
      expect(
        getContrastRatio(meta.color, meta.background),
        meta.label,
      ).toBeGreaterThanOrEqual(4.5);
  });
});
