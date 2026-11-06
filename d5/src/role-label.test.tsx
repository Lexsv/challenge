import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  architectInstructions,
  expertSchema,
  validateExperts,
} from "./generation";
import { ExpertRoleLabel } from "./expert-role-label";
import { createRun, Engine } from "./legacy-engine";
import { type Expert } from "./models";
import { settings } from "./openai-model-compat";

const definition = {
  name: "Name sentinel",
  roleLabel: "Filósofo experimental",
  description: "Description",
  rolePrompt: "Answer thoughtfully.",
};
const expert = (): Expert => ({ ...settings(""), ...definition, id: "expert" });

describe("role labels", () => {
  it("requires a nonempty arbitrary role label in generated output", () => {
    expect(expertSchema.properties.experts.items.required).toContain(
      "roleLabel",
    );
    for (const roleLabel of [
      "Filósofo experimental",
      "Everyday Person",
      "未来の庭師",
      "Unlisted role ".repeat(30),
    ]) {
      expect(
        validateExperts(
          JSON.stringify({ experts: [{ ...definition, roleLabel }] }),
          true,
        )[0].roleLabel,
      ).toBe(roleLabel);
    }
    for (const roleLabel of [undefined, "", "   ", 42, null]) {
      expect(() =>
        validateExperts(
          JSON.stringify({ experts: [{ ...definition, roleLabel }] }),
        ),
      ).toThrow();
    }
  });
  it("instructs both team and single generation to honor explicit language and default to English", () => {
    for (const single of [false, true]) {
      const instructions = architectInstructions(single);
      expect(instructions).toContain("explicitly requests a language");
      expect(instructions).toContain("otherwise roleLabel must be English");
      expect(instructions).toContain("Roles are unrestricted");
    }
  });
  it("retains captured labels after edits and deletion", () => {
    const team = [expert()];
    const run = createRun("Q", "R", team, "gpt-5.6-terra");
    team[0].roleLabel = "Changed";
    team.splice(0);
    expect(run.results[0].expert.roleLabel).toBe(definition.roleLabel);
    expect(run.snapshot.experts[0].roleLabel).toBe(definition.roleLabel);
    expect(Object.isFrozen(run.results[0].expert)).toBe(true);
  });
  it("keeps legacy snapshots unlabeled even after manual entry on the expert", () => {
    const legacy = expert();
    delete legacy.roleLabel;
    const run = createRun("Q", "R", [legacy], "gpt-5.6-terra");
    legacy.roleLabel = "Manually entered";
    expect(run.results[0].expert.roleLabel).toBeUndefined();
    expect(renderToStaticMarkup(<ExpertRoleLabel />)).toBe("");
    expect(renderToStaticMarkup(<ExpertRoleLabel roleLabel="  " />)).toBe("");
    const markup = renderToStaticMarkup(
      <ExpertRoleLabel roleLabel="<script>role</script>" />,
    );
    expect(markup).toContain("&lt;script&gt;role&lt;/script&gt;");
    expect(markup).toContain("overflow-wrap:anywhere");
  });
  it("excludes names and labels from evaluator metadata", async () => {
    const run = createRun("Q", "R", [expert()], "gpt-5.6-terra");
    let evaluated = false;
    await new Engine(
      () => {},
      async (_key, request) => {
        if (!request.schema)
          return { status: "succeeded", text: "Neutral answer", ms: 1 };
        evaluated = true;
        const input = JSON.parse(request.input);
        expect(Object.keys(input).sort()).toEqual([
          "answers",
          "question",
          "referenceAnswer",
        ]);
        expect(Object.keys(input.answers[0]).sort()).toEqual([
          "answer",
          "resultId",
        ]);
        expect(request.input).not.toContain(definition.name);
        expect(request.input).not.toContain(definition.roleLabel);
        return {
          status: "succeeded",
          text: JSON.stringify({
            evaluations: [
              {
                resultId: run.results[0].id,
                verdict: "correct",
                explanation: "Equivalent",
              },
            ],
          }),
          ms: 1,
        };
      },
    ).execute(run, "dummy-placeholder");
    expect(evaluated).toBe(true);
  });
});
