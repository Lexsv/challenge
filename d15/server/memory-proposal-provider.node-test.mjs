import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyProposalFormat,
  strictProposalFormat,
} from "./memory-proposal-provider.ts";
import { memoryProposalSchema } from "../src/memory-proposal.ts";
const model = "fixture-model";
const valid = JSON.stringify({
  version: 1,
  facts: [],
  topic: { kind: "dialogue" },
});
const result = (text, format, actual = model) => ({
  status: 200,
  body: {
    model: actual,
    status: "completed",
    text: { format },
    output: [{ content: [{ type: "output_text", text }] }],
  },
});
test("strict capability is specific to the actual model and complete schema", async () => {
  let calls = 0;
  const transport = async (provider, body) => {
    calls++;
    assert.deepEqual(body.text.format.schema, memoryProposalSchema);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.store, false);
    return result(valid, body.text.format, model);
  };
  assert.equal(await verifyProposalFormat("openai", model, transport), true);
  assert.equal(await verifyProposalFormat("openai", model, transport), true);
  assert.equal(calls, 1);
  assert.equal(
    await verifyProposalFormat("openai", "different", transport),
    false,
  );
});
test("unsupported schema, plain-text compliance and wrong model cannot enable strict mode", async () => {
  for (const reply of [
    { status: 502, body: { error: "Provider request failed (400)." } },
    result(valid, { type: "text" }),
    result("{}", strictProposalFormat("openai").text.format),
    result(valid, strictProposalFormat("openai").text.format, "unknown"),
  ])
    assert.equal(
      await verifyProposalFormat("openai", model, async () => reply),
      false,
    );
});
