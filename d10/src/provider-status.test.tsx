import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderStatus } from "./provider-status";
import type { VerificationStatus } from "./connection";
describe("OpenAI provider verification status", () => {
  it.each<[VerificationStatus, string]>([
    ["unverified", "Not verified"],
    ["verifying", "Checking…"],
    ["verified", "Verified"],
    ["failed", "Not verified"],
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

it("shows explicit rejection in red and inconclusive checks as Not verified with retry tooltips", () => {
  const rejected = renderToStaticMarkup(<ProviderStatus verification="unverified" savedStatus={{ saved: true, verification: 'not-authorized' }} />);
  expect(rejected).toContain('Not authorized');
  expect(rejected).toContain('MuiChip-colorError');
  const transient = renderToStaticMarkup(<ProviderStatus verification="unverified" savedStatus={{ saved: true, verification: 'retryable', reason: 'rate-limit' }} />);
  expect(transient).toContain('Not verified');
  expect(transient).toContain('The provider rate limit was reached. Retry Verify in Providers.');
  expect(transient).not.toContain('MuiChip-colorWarning');
  expect(transient).not.toContain('MuiChip-colorError');
});

it.each([
  [{ saved: false, verification: 'unchecked' } as const, 'No key is saved. Add a key in Providers and select Verify.'],
  [{ saved: true, verification: 'retryable', reason: 'timeout' } as const, 'The check timed out. Retry Verify in Providers.'],
  [{ saved: true, verification: 'retryable', reason: 'network-or-store' } as const, 'The check could not be completed. Retry Verify in Providers.'],
])('makes canned explanations keyboard focusable: %s', (status, explanation) => {
  const html = renderToStaticMarkup(<ProviderStatus verification="unverified" savedStatus={status} />);
  expect(html).toContain('tabindex="0"');
  expect(html).toContain(`title="${explanation}"`);
  expect(html).toContain('Not verified');
});

it('shows a compact labelled spinner while checking without a verbose chip', () => {
  const html = renderToStaticMarkup(<ProviderStatus verification="unverified" savedStatus={{ saved: true, verification: 'checking' }} />);
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-label="Checking OpenAI credentials"');
  expect(html).toContain('width:16px');
  expect(html).not.toContain('MuiChip-root');
});
