// Only inspect result fields and text blocks. Protocol metadata, documentation
// examples, and URL fragments inside prose are not artifact references.
export function mcpResultEvidence(value: unknown) {
  const links = new Set<string>();
  let created = false;
  let substantive = false;
  const link = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^https?:\/\//i.test(value) ||
      /[\s<>"\\]|\[redacted\]/i.test(value)
    )
      return;
    try {
      const url = new URL(value);
      if (!url.username && !url.password) links.add(value);
    } catch {
      /* Not a usable reference. */
    }
  };
  function inspect(value: unknown, depth = 0) {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value) || typeof value !== "object") {
      substantive = true;
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.ok === false || object.success === false || object.error) return;
    if (object.created === true || object.status === "created") created = true;
    for (const [key, item] of Object.entries(object)) {
      if (/^(url|link|permalink|web_url|designUrl|itemUrl)$/i.test(key))
        link(item);
      if (
        !["ok", "success", "status", "result", "data", "_meta"].includes(key) &&
        item != null
      )
        substantive = true;
    }
    inspect(object.result, depth + 1);
    inspect(object.data, depth + 1);
  }
  const output = value as {
    structuredContent?: unknown;
    content?: { text?: unknown }[];
  } | null;
  inspect(output?.structuredContent);
  for (const block of output?.content ?? []) {
    if (typeof block.text !== "string") continue;
    const text = block.text.trim();
    link(text);
    try {
      inspect(JSON.parse(text));
    } catch {
      if (
        text &&
        !/^(?:ok|success(?:ful)?|done|completed|accepted|acknowledged)[.!]?$/i.test(
          text,
        )
      )
        substantive = true;
    }
  }
  return { created, substantive, links: [...links] };
}
