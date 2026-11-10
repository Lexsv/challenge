import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@mui/material/styles";
import { theme } from "./theme";
describe("Day 6 theme", () => {
  it("uses a warm cream and lavender palette with readable control and text contrast", () => {
    expect(theme.palette.background.default).toBe("#FAF8F4");
    expect(theme.palette.primary.main).toBe("#6C5CE7");
    expect(theme.palette.secondary.main).toBe("#EEE5FA");
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
