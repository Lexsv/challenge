import {
  memoryProposalSchema,
  parseMemoryProposal,
} from "../src/memory-proposal.ts";

type Reply = { status: number; body: unknown };
type Transport = (
  provider: string,
  body: Record<string, unknown>,
) => Promise<Reply>;
export function strictProposalFormat(provider: string) {
  const definition = {
    name: "memory_proposal_v1",
    strict: true,
    schema: memoryProposalSchema,
  };
  return provider === "openai"
    ? { text: { format: { type: "json_schema", ...definition } } }
    : { response_format: { type: "json_schema", json_schema: definition } };
}

// Probe the actual endpoint with the exact extraction schema and no conversation.
// A plain-text endpoint following instructions must not be mistaken for strict mode.
const capabilities = new WeakMap<Transport, Map<string, Promise<boolean>>>();
export function verifyProposalFormat(
  provider: string,
  model: string,
  transport: Transport,
) {
  let cache = capabilities.get(transport);
  if (!cache) {
    cache = new Map();
    capabilities.set(transport, cache);
  }
  const key = JSON.stringify([provider, model]);
  const cached = cache.get(key);
  if (cached) return cached;
  const probe = async () => {
    const instruction =
      "Return a version 1 proposal for ordinary dialogue, with empty facts. If your response is unconstrained return the plain word UNCONSTRAINED instead.";
    const messages = [{ role: "user", content: instruction }];
    const body = {
      model,
      ...(provider === "openai"
        ? { store: false, input: messages }
        : { messages }),
      ...strictProposalFormat(provider),
    };
    const { status, body: raw } = await transport(provider, body);
    const data = raw as {
      model?: string;
      status?: string;
      error?: string;
      text?: { format?: { type?: string; strict?: boolean; name?: string } };
      output?: { content?: { type: string; text: string }[] }[];
      response_format?: {
        type?: string;
        json_schema?: { name?: string; strict?: boolean };
      };
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    if (status !== 200) {
      if (
        [400, 404, 422].includes(status) ||
        /\((400|404|422)\)/.test(data?.error ?? "")
      )
        return false;
      throw Error("Memory proposal capability check unavailable.");
    }
    if (data.model !== model) return false;
    if (
      provider === "openai" &&
      (data.status !== "completed" ||
        data.text?.format?.type !== "json_schema" ||
        data.text.format.strict !== true ||
        data.text.format.name !== "memory_proposal_v1")
    )
      return false;
    if (
      provider !== "openai" &&
      (data.response_format?.type !== "json_schema" ||
        data.response_format.json_schema?.strict !== true ||
        data.response_format.json_schema.name !== "memory_proposal_v1")
    )
      return false;
    const content =
      provider === "openai"
        ? data.output
            ?.flatMap((o) => o.content ?? [])
            .find((c) => c.type === "output_text")?.text
        : data.choices?.[0]?.message?.content;
    try {
      const p = parseMemoryProposal(JSON.parse(content ?? ""));
      return p.topic.kind === "dialogue" && !p.facts.length;
    } catch {
      return false;
    }
  };
  const result = probe().catch(() => {
    cache.delete(key);
    return false;
  });
  cache.set(key, result);
  return result;
}
