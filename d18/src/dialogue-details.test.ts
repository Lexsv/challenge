import { expect, it } from "vitest";
import {
  dialogueDetail,
  findDialogueDetail,
  requiredDetails,
  retainDetails,
} from "./dialogue-details";
import type { MemoryGroup } from "./session-memory";

const group = (id: string, text: string): MemoryGroup => ({
  id,
  sourceIds: [id + "-user"],
  messages: [{ role: "user", content: text }],
});
it("keeps an explicitly remembered story detail through repeated consolidation without creating duplicate passages", () => {
  const info = "A blue envelope was on the bench.";
  const source = group("r1", "Remember this detail: " + info);
  expect(requiredDetails([source, source])).toEqual([info]);
  const reviewed = retainDetails("We discussed a mystery.", [info]);
  expect(retainDetails(reviewed, [info])).toBe(reviewed);
  expect(
    findDialogueDetail([source], "Which envelope was on the bench?", [])
      ?.original,
  ).toEqual({ runId: "r1", messageId: "r1-user", role: "user", excerpt: info });
});
it("leaves ordinary plan or preference updates to the proposal executor", () => {
  expect(dialogueDetail("Remember: I prefer hiking.")).toBeUndefined();
  expect(dialogueDetail("Дату похода запомни: 20 июля.")).toBeUndefined();
});
it("does not guess among competing remembered details", () => {
  const sources = [
    "Blue stars were painted on the door.",
    "Gold stars were painted on the door.",
  ].map((s, i) => group(String(i), "For the story, remember: " + s));
  expect(
    findDialogueDetail(sources, "Which stars were painted on the door?", []),
  ).toBeUndefined();
});
it("keeps similar dialogue details in the named trip", () => {
  const cards = ["lake", "sea"].map((id) => ({
    id,
    description: id + " trip",
    tags: [id],
    changes: [],
  }));
  const sources = [
    group(
      "lake-turn",
      "Remember this detail: The blue envelope lay on the bench at the lake.",
    ),
  ];
  expect(
    findDialogueDetail(
      sources,
      "Which envelope lay on the bench at the sea?",
      cards,
    ),
  ).toBeUndefined();
  expect(
    findDialogueDetail(
      sources,
      "Which envelope lay on the bench at the lake?",
      cards,
    )?.original.runId,
  ).toBe("lake-turn");
});
