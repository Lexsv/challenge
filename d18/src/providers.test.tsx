import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { Providers } from "./providers";
import { ProviderModelTable } from "./provider-model-table";
import { createProviderRegistry } from "./provider-registry";
import { ParameterEditor } from "./parameter-editor";
import { parameterPayload } from "./api-parameters";
import { credentials, configuredProviderProblem, type SavedCredentialStatus } from "./saved-credentials";
import { theme } from "./theme";

describe("provider settings", () => {
  it("hides inactive Go while showing the remaining provider cards", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const snapshot = vi.spyOn(credentials, "getSnapshot").mockReturnValue({
      openai: { saved: true, verification: "verified" }, "opencode-console": { saved: true, verification: "unchecked" }
    });
    const html = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <Providers
          model="test-model"
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
    for (const match of html.matchAll(/role="status"[^>]*>(.*?)<\/span>/gs)) expect(match[1]).not.toContain("MuiChip");
    expect(html).toContain("Not verified");
    expect(html).toContain("Forget all keys");
    expect(html).not.toContain("Remember on this Mac");
    expect(fetcher).not.toHaveBeenCalled();
    expect(html.match(/aria-label="OpenAI: Verified"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="OpenCode Console: Not verified"');
    snapshot.mockRestore();
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

it.each<[SavedCredentialStatus, boolean]>([
  [{ saved: false, verification: "not-authorized" }, false],
  [{ saved: false, verification: "unchecked", presencePending: true }, false],
  [{ saved: true, verification: "unchecked" }, false],
  [{ saved: true, verification: "checking" }, false],
  [{ saved: true, verification: "verified" }, false],
  [{ saved: true, verification: "retryable", reason: "network-or-store" }, true],
  [{ saved: true, verification: "retryable", removalFailed: true }, false],
  [{ saved: true, verification: "not-authorized" }, true],
  [{ saved: true, verification: "retryable", reason: "http-503" }, true],
  [{ saved: true, verification: "retryable", reason: "permission" }, true],
  [{ saved: true, verification: "retryable", reason: "timeout" }, true],
  [{ saved: true, verification: "retryable", reason: "rate-limit" }, true],
])("classifies the Providers navigation indicator for %j", (status, expected) => {
  expect(configuredProviderProblem(status)).toBe(expected);
});

it("shows a configured Go provider and its actionable status in the list", () => {
  const snapshot = vi.spyOn(credentials, "getSnapshot").mockReturnValue({
    "opencode-go": { saved: true, verification: "retryable", reason: "permission" }
  });
  try {
    expect(renderToStaticMarkup(<Providers model="fixture" />)).toContain('aria-label="OpenCode Go: Not verified · Access denied"');
  } finally {
    snapshot.mockRestore();
  }
});
