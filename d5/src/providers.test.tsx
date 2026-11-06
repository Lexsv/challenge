import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { Providers } from "./providers";
import { ParameterEditor } from "./parameter-editor";
import { parameterPayload } from "./api-parameters";
import { theme } from "./theme";

describe("provider settings", () => {
  it("shows only OpenAI as the default provider with the current verification state", () => {
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
    expect(html).not.toContain("Gemini");
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
