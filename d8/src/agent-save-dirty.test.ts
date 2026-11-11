import { describe, expect, it } from "vitest";
import { hasUnsavedAgentChanges } from "./main";
import type { Expert } from "./models";

const expert = (id: string, name = "Agent"): Expert => ({
  id,
  name,
  roleLabel: "Role",
  description: "Description",
  rolePrompt: "Prompt",
  provider: "openai",
  model: "gpt-5.6-terra",
  maxTokens: 2048,
  parameters: [],
});

describe("agent save dirty state", () => {
  it("is false when draft equals last saved state", () => {
    const saved = expert("a1");
    const draft = structuredClone(saved);
    expect(hasUnsavedAgentChanges(saved, draft, true, [])).toBe(false);
  });

  it("becomes true after any editable change and false after revert", () => {
    const saved = expert("a1");
    const changed = { ...saved, rolePrompt: "Updated prompt" };
    expect(hasUnsavedAgentChanges(saved, changed, true, [])).toBe(true);
    expect(hasUnsavedAgentChanges(saved, { ...saved }, true, [])).toBe(false);
  });

  it("tracks active toggle changes and clears after successful save baseline update", () => {
    const saved = expert("a1");
    const inactiveIds = [saved.id];
    expect(
      hasUnsavedAgentChanges(saved, { ...saved }, true, inactiveIds),
    ).toBe(true);
    expect(
      hasUnsavedAgentChanges(saved, { ...saved }, false, inactiveIds),
    ).toBe(false);
  });

  it("preserves dirty state for retry when save baseline is unchanged", () => {
    const saved = expert("a1");
    const changed = { ...saved, description: "Changed description" };
    expect(hasUnsavedAgentChanges(saved, changed, true, [])).toBe(true);
    expect(hasUnsavedAgentChanges(saved, changed, true, [])).toBe(true);
  });

  it("initializes per selected agent baseline and supports generated persisted agents", () => {
    const first = expert("a1", "First");
    const second = expert("a2", "Second");
    const secondDraft = { ...second };
    expect(hasUnsavedAgentChanges(second, secondDraft, true, [])).toBe(false);
    const switchedDraft = { ...first, name: "First edited" };
    expect(hasUnsavedAgentChanges(first, switchedDraft, true, [])).toBe(true);
    const generatedPersisted = expert("g1", "Generated");
    expect(
      hasUnsavedAgentChanges(
        generatedPersisted,
        structuredClone(generatedPersisted),
        true,
        [],
      ),
    ).toBe(false);
  });
});
