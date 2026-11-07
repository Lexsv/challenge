import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { Providers } from "./providers";
import { ParameterEditor } from "./parameter-editor";
import { parameterPayload } from "./api-parameters";
import { theme } from "./theme";

describe("provider settings", () => {
  it("shows four distinct built-in provider cards with the current OpenAI verification state", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <Providers
          model="test-model"
          verification="verified"
          openAISettings={<span>OpenAI settings</span>}
        />
      </ThemeProvider>,
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain("Default");
    expect(html).toContain("Verified");
    expect(html).toContain("test-model");
    expect(html).toContain("Add Provider");
    expect(html).toContain("OpenCode");
    expect(html).toContain("Google Gemini");
    expect(html).toContain("OpenCode Console");
    expect(html).toContain("OpenCode Go");
    expect(html).toContain("Pay as you go");
    expect(html).toContain("Subscription");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
  it("reuses the parameter editor and excludes disabled values from request payloads", () => {
    const parameters = [
      { id: "a", enabled: true, key: "temperature", value: "0.7" },
      { id: "b", enabled: false, key: "other", value: "true" },
    ];
    const html = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <ParameterEditor parameters={parameters} onChange={() => {}} />
      </ThemeProvider>,
    );
    expect(html).toContain("temperature");
    expect(html).toContain("other");
    expect(parameterPayload(parameters)).toEqual({ temperature: 0.7 });
  });
});
