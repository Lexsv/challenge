import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { Providers } from "./providers";
import { ProviderModelTable } from "./provider-model-table";
import { createProviderRegistry } from "./provider-registry";
import { ParameterEditor } from "./parameter-editor";
import { parameterPayload } from "./api-parameters";
import { theme } from "./theme";

describe("provider settings", () => {
  it("hides inactive Go while showing the remaining provider cards", () => {
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
    expect(html).not.toContain(">Default<");
    expect(html).toContain("Verified");
    expect(html).toContain("test-model");
    expect(html).not.toContain("Add Provider");
    expect(html).toContain('aria-label="Open OpenAI settings"');
    expect(html).not.toContain(">Connection Settings<");
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("Google Gemini");
    expect(html).toContain("OpenCode Console");
    expect(html).not.toContain("OpenCode Go");
    expect(html).toContain("OpenAI: Verified");
    expect(html).toContain("Not verified");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
  it("renders one default-model indicator and aligned settings actions for every model", () => {
    const ids = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol"];
    const html = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <ProviderModelTable ids={ids} provider="openai" selectedModel={ids[1]}
          view="models" registry={createProviderRegistry()} onConfigure={vi.fn()} />
      </ThemeProvider>,
    );
    const rows = Array.from(html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs), ([, row]) => row).slice(1);
    expect(html).toContain(">Options<");
    expect(rows).toHaveLength(ids.length);
    rows.forEach((row, index) => {
      expect(row).toContain(`aria-label="Configure model ${ids[index]}"`);
      expect(row.includes("<title>Default model</title>")).toBe(index === 1);
    });
    expect(html).toContain("grid-template-columns:28px 32px");
    expect(html).toContain("grid-column:2");
    expect(html).not.toContain(">Configure<");
    expect(html).not.toContain(">Selected<");
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
