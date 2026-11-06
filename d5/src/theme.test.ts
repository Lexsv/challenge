import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@mui/material/styles";
import { theme } from "./theme";
describe("Day 5 theme", () => {
  it("uses a warm yellow palette with readable control and text contrast", () => {
    expect(theme.palette.background.default).toBe("#FFFDF5");
    expect(theme.palette.primary.main).toBe("#F5D76E");
    expect(theme.palette.secondary.main).toBe("#FFF3C4");
    expect(
      getContrastRatio(
        theme.palette.text.primary,
        theme.palette.background.default,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      getContrastRatio(
        theme.palette.primary.contrastText,
        theme.palette.primary.main,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      getContrastRatio(
        theme.palette.primary.dark,
        theme.palette.background.default,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
