import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderStatus } from "./provider-status";
import type { VerificationStatus } from "./connection";
describe("OpenAI provider verification status", () => {
  it.each<[VerificationStatus, string]>([
    ["unverified", "Not verified"],
    ["verifying", "Verifying"],
    ["verified", "Verified"],
    ["failed", "Verification failed"],
  ])("renders %s accessibly", (state, label) => {
    const html = renderToStaticMarkup(<ProviderStatus verification={state} />);
    expect(html).toContain(`aria-label="OpenAI: ${label}"`);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Online");
    expect(html).not.toContain("Gemini");
  });
});


it("renders a matching Console status without confusing model verification with connectivity", () => {
  const html = renderToStaticMarkup(<ProviderStatus provider="OpenCode Console" verification="verified" />);
  expect(html).toContain("OpenCode Console · Verified");
  expect(html).toContain("MuiChip-colorSuccess");
  expect(html).not.toContain("Online");
  expect(renderToStaticMarkup(<ProviderStatus provider="OpenCode Console" verification="unchecked" />)).toContain("OpenCode Console · Not verified");
});
