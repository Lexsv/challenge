import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleVerificationStatus, consoleStatusKind } from "./console-verification-status";
import { createProviderRegistry } from "./provider-registry";
import { resolveExpert } from "./models";

describe("Console verification presentation", () => {
  it("shows a green Verified indicator only for confirmed authentication and model success", () => {
    const success = "Authentication verified for this operation. Model verified: kimi-k3. Endpoint: https://opencode.ai/inference/openai/v1/chat/completions. Other models are not verified.";
    expect(consoleStatusKind(success)).toBe("verified");
    const html = renderToStaticMarkup(<ConsoleVerificationStatus status={success} />);
    expect(html).toContain("Verified");
    expect(html).toContain("MuiChip-colorSuccess");
    expect(html).not.toContain("kimi-k3");
    expect(html).not.toContain("https://opencode.ai");
    expect(renderToStaticMarkup(<ConsoleVerificationStatus status={success} unsaved />)).toContain("Provider settings have unsaved changes.");
  });
  it("keeps catalog availability, failures, and partial checks distinct", () => {
    expect(consoleStatusKind("Verifying connection…")).toBe("verifying");
    expect(consoleStatusKind("Catalog available: authentication not checked")).toBe("unchecked");
    expect(consoleStatusKind("Authentication failed (401). Check the key privately.")).toBe("failed");
    expect(consoleStatusKind("Authentication: not established. Model access or permission denied (403).")).toBe("failed");
    expect(consoleStatusKind("Authentication verified for this operation. Model result inconclusive: kimi-k3.")).toBe("inconclusive");
    expect(consoleStatusKind("Authentication: inconclusive; this endpoint or model may not require a credential. Model verified: kimi-k3.")).toBe("inconclusive");
    expect(renderToStaticMarkup(<ConsoleVerificationStatus status="Authentication failed (401)." />)).toContain("MuiChip-colorError");
  });
  it("retains the Go adapter and existing expert identity", () => {
    expect(createProviderRegistry().get("opencode-go")).toBeDefined();
    const expert = { id: "x", name: "A", description: "D", rolePrompt: "R", provider: "opencode-go", model: "kimi-k3", maxTokens: 128, parameters: [] };
    expect(resolveExpert(expert, "other", "openai")).toEqual(expert);
  });
});

it('does not expose raw provider messages or mark permission errors as rejected keys', () => {
  const html = renderToStaticMarkup(<ConsoleVerificationStatus status="Authentication: not established. Model access or permission denied (403). placeholder-private-message" />);
  expect(html).toContain('Not verified');
  expect(html).not.toContain('MuiChip-colorError');
  expect(html).not.toContain('placeholder-private-message');
  expect(html).toContain('Check permissions and retry Verify in Providers.');
});
