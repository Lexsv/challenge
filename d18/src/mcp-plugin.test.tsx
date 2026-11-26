import {parameterEndpoint, editableEndpoint, type ParameterAuth} from "./mcp-parameters";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CatalogContents,
  connectionStatus,
  JsonView,
  McpRow,
  McpParameterValue,
} from "./mcp-plugin";
import type { McpCatalog, McpConnection } from "./mcp-connections";

const connection: McpConnection = {
  connectionId: "connection",
  name: "Fixture",
  description: "Test catalog",
  endpoint: "https://example.com/mcp",
  transport: "sse",
  auth: { type: "none" },
  revision: 1,
  toolCount: 2,
  lastSuccess: 1000,
  stale: false,
  error: null,
};
describe("MCP tools presentation", () => {
  it("renders one plugin row with catalog, settings and refresh actions", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <McpRow
            item={connection}
            busy={false}
            open={() => {}}
            edit={() => {}}
            refresh={() => {}}
            remove={() => {}}
          />
        </tbody>
      </table>,
    );
    for (const text of [
      "MCP Plugin",
      "Fixture",
      "Refresh Fixture",
      "Settings for Fixture",
      "Delete Fixture",
      "PowerOutlinedIcon",
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/>2<\/td>/);
    expect(html).toMatch(/-webkit-line-clamp:2/i);
    expect(html).toContain("#FFF4CC");
    expect(html).toContain("#806000");
    expect(html).not.toMatch(/Last discovery|Catalog up to date/);
  });
  it("shows the original schemas and additional metadata for the selected tool", () => {
    const catalog: McpCatalog = {
      connection,
      tools: ["alpha", "beta"].map((name) => ({
        toolId: name,
        originalName: name,
        connectionId: "connection",
        document: {
          name,
          description: "Nested output",
          inputSchema: {
            type: "object",
            properties: { args: { type: "array", minItems: 2 } },
          },
          outputSchema: { type: "object" },
          vendor: { hint: "keep" },
        },
      })),
    };
    const html = renderToStaticMarkup(<CatalogContents catalog={catalog} onRemove={() => {}} />);
    expect(html).toContain('aria-label="Remove alpha"');
    expect(html).not.toContain('aria-label="Remove beta"');
    for (const text of [
      "alpha",
      "beta",
      "Nested output",
      "Input JSON Schema",
      "Output JSON Schema",
      "Additional metadata",
      "minItems",
      "vendor",
    ])
      expect(html).toContain(text);
  });
  it("escapes remote strings in syntax-highlighted JSON", () => {
    expect(
      renderToStaticMarkup(<JsonView value={{ help: "<img src=x>" }} />),
    ).toContain("&lt;img src=x&gt;");
  });
  it("distinguishes cache freshness, first discovery and errors", () => {
    expect(connectionStatus(connection)).toMatch(/up to date/);
    expect(connectionStatus({ ...connection, stale: true })).toMatch(/stale/);
    expect(connectionStatus({ ...connection, lastSuccess: null })).toMatch(
      /Awaiting/,
    );
    expect(connectionStatus({ ...connection, error: "permission" })).toMatch(
      /permission/,
    );
  });
});


it("keeps a saved secret masked until explicit Show and renders ordinary parameter values normally", () => {
  let reveals = 0;
  const props = {
    label: "fixture",
    value: "",
    change: () => {},
    onError: () => {},
  };
  const masked = renderToStaticMarkup(
    <McpParameterValue
      {...props}
      secret
      reveal={async () => {
        reveals++;
        return "synthetic-only";
      }}
    />,
  );
  expect(masked).toContain('type="password"');
  expect(masked).toContain("••••••••");
  expect(masked).toContain("Show fixture");
  expect(masked).not.toContain("synthetic-only");
  expect(reveals).toBe(0);
  const plain = renderToStaticMarkup(
    <McpParameterValue {...props} secret={false} value="en-CA" />,
  );
  expect(plain).toContain("en-CA");
  expect(plain).not.toContain("Show fixture");
});

it("includes public query settings in endpoint identity and restores them as editable rows", () => {
  const auth: ParameterAuth = {type:"query",rows:[
    {key:"locale",value:"en CA",secret:false,enabled:true},
    {key:"userToken",secret:true,enabled:true},
  ]};
  const base = "https://fixture.invalid/mcp?route=a%20b";
  const effective = parameterEndpoint(base, auth)!;
  expect(effective).toBe(base+"&locale=en+CA");
  expect(parameterEndpoint(effective, auth)).toBe(effective);
  expect(editableEndpoint(effective, auth)).toBe(base);
  expect(parameterEndpoint(base+"&userToken=illustration", auth)).toBeUndefined();
});

it("distinguishes saved permissions, advertised capabilities, observed links and live SSE", () => {
  function render(enabled: boolean, live: boolean, resourceError?: string) {
    return renderToStaticMarkup(<CatalogContents onWatch={() => {}} catalog={{
      connection:{...connection, sseObserved:true, sseActive:live, capabilities:{subscribe:true}, resourceError},
      tools:[{toolId:"tool",connectionId:connection.connectionId,originalName:"lookup",
        document:{inputSchema:{}},resourceLinksObserved:live,watchAttachedChats:enabled,watchEnabled:true}]
    }}/>);
  }
  const off = render(false,false);
  for (const label of ["no open SSE stream", "SSE previously observed", "server advertised support",
    "no validated typed link observed", "disabled for attached chats", "VisibilityOffIcon", "Automatic Resource Watching"])
    expect(off).toContain(label);
  const on = render(true,true);
  for (const label of ["SSE stream open", "typed link observed from this tool", "enabled for attached chats",
    "VisibilityIcon", 'checked=""']) expect(on).toContain(label);
  expect(render(true,false,"permission")).toContain("resource discovery failed (permission)");
});


it.each(["light", "dark"] as const)("labels and outlines an empty masked bearer field in the %s theme", mode => {
  const html = renderToStaticMarkup(
    <ThemeProvider theme={createTheme({palette: {mode}})}>
      <McpParameterValue outlined secret label="Bearer Token" value="" change={()=>{}} onError={()=>{}} />
    </ThemeProvider>
  );
  expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Bearer Token<\/label>/);
  expect(html).toContain("MuiOutlinedInput-notchedOutline");
  expect(html).toContain('type="password"');
  expect(html).toContain('aria-label="Show Bearer Token"');
});
