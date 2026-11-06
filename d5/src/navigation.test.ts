import { describe, expect, it } from "vitest";
import { initialLabTab } from "./navigation";
describe("initial navigation", () => {
  it("opens settings without a usable key and model", () => {
    expect(initialLabTab("", "gpt-5.6-terra")).toBe("settings");
    expect(initialLabTab("dummy", "unknown-model")).toBe("settings");
    expect(initialLabTab("dummy", "")).toBe("settings");
  });
  it("opens the lab with restored credentials and a supported model", () => {
    expect(initialLabTab("dummy", "gpt-5.6-terra")).toBe("lab");
  });
});
