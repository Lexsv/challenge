import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionStatsContent } from "./session-stats-panel";
import { TopicCardsPanel } from "./topic-cards-panel";
import type { Catalog } from "./topic-cards";

it("opens only Tokens by default and distinguishes missing counts from reported zero", () => {
  const markup = renderToStaticMarkup(
    <SessionStatsContent compact={{ model: "chosen-model" }} />,
  );
  expect(markup).toContain("chosen-model");
  expect(markup).toContain("Counts unavailable");
  expect(markup).toContain("Requests unavailable");
  const headers = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(headers).toHaveLength(4);
  expect(headers[0]).toContain("Tokens");
  expect(headers[0]).toContain('aria-expanded="true"');
  for (const header of headers.slice(1))
    expect(header).toContain('aria-expanded="false"');
  const reported = renderToStaticMarkup(
    <SessionStatsContent
      compact={{ security: { blocked: 0, redacted: 2, withheld: 1 } }}
    />,
  );
  expect(reported).toContain("0 blocked · 2 redacted · 1 withheld");
});

it("previews effective values and counts canonical field versions without counting repeat confirmations", () => {
  const first = {
    id: "a",
    at: 1,
    order: 1,
    field: "date",
    value: "Friday",
    evidence: "Original agreement",
  };
  const catalog: Catalog = {
    cards: [
      {
        id: "trip",
        description: "Поездка к озеру",
        tags: ["лето"],
        changes: [
          first,
          { ...first, id: "b", at: 2, value: "Saturday" },
          {
            ...first,
            id: "c",
            at: 3,
            field: "participants",
            value: ["Лена", "Вера"],
          },
        ],
        confirmations: [
          {
            ...first,
            id: "d",
            at: 4,
            value: "Saturday",
            evidence: "Private to the details view",
          },
        ],
      },
    ],
  };
  const original = structuredClone(catalog);
  const markup = renderToStaticMarkup(
    <TopicCardsPanel
      catalog={catalog}
      disabled={false}
      finish={async () => {}}
    />,
  );
  const heading = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(heading).toContain('aria-expanded="false"');
  expect(heading).toContain("Topic Cards");
  expect(heading).toContain("1 card");
  for (const text of [
    "Saturday",
    "Лена, Вера",
    "2 fields · 3 versions",
    "View details for Поездка к озеру",
  ])
    expect(markup).toContain(text);
  expect(markup).not.toContain("<table");
  expect(markup).not.toContain("Original agreement");
  expect(markup).not.toContain("Private to the details view");
  expect(catalog).toEqual(original);
});
