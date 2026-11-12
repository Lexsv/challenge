import { vintagePalette as p } from "./vintage-palette";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ToolsPage,
  BuiltInToolRow,
  deleteToolRecord,
  pseudocodePreviewHtml,
  rawToolConfiguration,
  saveToolRecord,
  validateToolDraft,
  type ToolRecord,
} from "./tools-page";
import { createBuiltInToolRegistry } from "./tool-runtime";

const toolRegistry = createBuiltInToolRegistry();

const agent = {
  id: "agent-1",
  name: "Analyst",
  description: "Analyzes",
  rolePrompt: "Analyze",
  model: "gpt-5.6-terra",
  maxTokens: 1024,
};

describe("tools page lifecycle", () => {
  it('validates two- and three-input formulas before saving', () => {
    const draft = {id:'id', type:'Function' as const, name:'Calculator', description:'Compute', config:{definition:'Inputs:\n a: number\n b: number\nFormula:\n result = a + b\nOutput:\n result: number'}};
    expect(validateToolDraft(draft, [])).toBeUndefined();
    const three = {...draft,config:{definition:draft.config.definition.replace(' b: number',' b: number\n c: number').replace('a + b','a + b + c')}};
    expect(validateToolDraft(three, [])).toBeUndefined();
    expect(validateToolDraft({...draft,config:{definition:draft.config.definition.replace('a + b','a ** b')}}, [])).toContain('Unsupported formula syntax');
  });
  it("shows built-in metadata and a separate custom empty state", () => {
    const html = renderToStaticMarkup(<ToolsPage agents={[]} toolRegistry={toolRegistry} />);
    expect(html).toContain("Built-in Tools");
    expect(html).toContain("Custom Tools");
    expect(html).toContain("No custom tools yet");
    expect(html).toContain(
      "Create your first custom tool to extend your agents&#x27; capabilities.",
    );
    expect(html.match(/>Add custom tool</g)).toHaveLength(1);
    for (const tool of toolRegistry.listBuiltIn()) {
      expect(html).toContain(tool.name);
      expect(html).toContain(tool.id);
      expect(html).toContain(tool.description);
      expect(html).toContain("Input schema");
    }
    expect(html).toContain("Tax rate percentage.");
    expect(html).toContain("Function");
    expect(html).toContain("HTTP API");
    expect(html).not.toContain(">Built-in<");
    expect(html).not.toContain("Edit tool Tax Calculator");
    expect(html).not.toContain("Delete tool Tax Calculator");
    expect(html).not.toContain("Run Tool");
  });

  it("shows created custom tools in a table with the custom-section add button", () => {
    const tools: ToolRecord[] = [
      {
        id: "tool-1",
        name: "Discount Calculator",
        type: "Function",
        description: "Calculates discount totals.",
        config: { definition: "result = price * 0.9" },
      },
    ];
    const html = renderToStaticMarkup(
      <ToolsPage agents={[agent]} toolRegistry={toolRegistry} initialTools={tools} />,
    );
    expect(html).toContain("Discount Calculator");
    expect(html).toContain("Function");
    expect(html).toContain("Edit tool Discount Calculator");
    expect(html).toContain("Delete tool Discount Calculator");
    expect(html).toContain('aria-label="Custom tools"');
    expect(html).not.toContain('>Tool ID<');
    expect(html).toContain('MuiTableCell-alignRight');
    expect(html.match(/>Add custom tool</g)).toHaveLength(1);
    expect(html).not.toContain("aspect-ratio:1 / 1");
  });

  it("renders tool details affordance and dialog hooks", () => {
    const tools: ToolRecord[] = [
      {
        id: "tool-1",
        name: "Endpoint Reader",
        type: "API Tool",
        description: "Reads endpoint value.",
        config: {
          endpoint: "https://api.example.com/items",
          method: "GET",
          resultPath: "result.value",
          parameters: [],
        },
      },
    ];
    const html = renderToStaticMarkup(
      <ToolsPage agents={[agent]} toolRegistry={toolRegistry} initialTools={tools} />,
    );
    expect(html).toContain('aria-label="Edit tool Endpoint Reader"');
    expect(html).toContain('aria-label="Delete tool Endpoint Reader"');
    expect(html).toContain("tabindex=\"0\"");
  });

  it("validates required fields for tool creation", () => {
    const base = {
      id: "tool-1",
      type: "Function" as const,
      name: "",
      description: "",
      config: { definition: "" },
    };
    expect(validateToolDraft(base, [agent])).toBe("Tool name is required.");
    expect(
      validateToolDraft({ ...base, name: "Calc", description: "" }, [agent]),
    ).toBe("Description is required.");
  });

  it("validates type-specific requirements", () => {
    expect(
      validateToolDraft(
        {
          id: "tool-api",
          type: "API Tool",
          name: "Currency",
          description: "Converts",
          config: { endpoint: "", method: "GET", resultPath: "", parameters: [] },
        },
        [agent],
      ),
    ).toBe("Endpoint URL is required.");
    expect(
      validateToolDraft(
        {
          id: "tool-ai",
          type: "AI Agent Tool",
          name: "Expert",
          description: "Delegates",
          config: { agentId: "" },
        },
        [agent],
      ),
    ).toBe("Select an agent for this tool.");
  });

  it("creates exactly one new tool and preserves ids on edit", () => {
    const created = saveToolRecord(
      [],
      {
        id: "tool-1",
        name: "Discount",
        type: "Function",
        description: "Calculates",
        config: { definition: "result = price * 0.9" },
      },
      "create",
    );
    expect(created).toHaveLength(1);
    const edited = saveToolRecord(
      created,
      {
        ...created[0],
        name: "Discount v2",
      },
      "edit",
    );
    expect(edited).toHaveLength(1);
    expect(edited[0].id).toBe("tool-1");
    expect(edited[0].name).toBe("Discount v2");
  });

  it("deletes only the selected tool and returns to empty when last is removed", () => {
    const tools: ToolRecord[] = [
      {
        id: "tool-1",
        name: "A",
        type: "Function",
        description: "A desc",
        config: { definition: "a" },
      },
      {
        id: "tool-2",
        name: "B",
        type: "API Tool",
        description: "B desc",
        config: { endpoint: "https://api.example.com", method: "GET", resultPath: "", parameters: [] },
      },
    ];
    const oneLeft = deleteToolRecord(tools, "tool-1");
    expect(oneLeft.map((tool) => tool.id)).toEqual(["tool-2"]);
    const empty = deleteToolRecord(oneLeft, "tool-2");
    expect(empty).toEqual([]);
  });

  it("keeps raw and preview representations aligned for function pseudocode", () => {
    const source = "if score >= 80\n  return \"pass\"\n# keep spacing";
    const html = pseudocodePreviewHtml(source);
    expect(html).toContain("pass");
    expect(html).toContain("font-weight:600");
    expect(html).toContain("font-style:italic");
    expect(source).toContain("# keep spacing");
  });

  it("renders raw sanitized configuration for API and AI tools", () => {
    const apiTool: ToolRecord = {
      id: "api-1",
      name: "API",
      type: "API Tool",
      description: "desc",
      config: {
        endpoint: "https://api.example.com",
        method: "POST",
        resultPath: "payload.id",
        parameters: [{ id: 1, name: "q", location: "query", example: "x" }],
      },
    };
    const aiTool: ToolRecord = {
      id: "ai-1",
      name: "Agent Ref",
      type: "AI Agent Tool",
      description: "desc",
      config: { agentId: "missing-agent" },
    };
    const apiRaw = rawToolConfiguration(apiTool, [agent]);
    const aiRaw = rawToolConfiguration(aiTool, [agent]);
    expect(apiRaw).toContain("method: POST");
    expect(apiRaw).toContain("endpoint: https://api.example.com");
    expect(aiRaw).toContain("agentName: (missing)");
  });

  it("does not mutate tools when deriving raw views", () => {
    const tool: ToolRecord = {
      id: "func-1",
      name: "Math",
      type: "Function",
      description: "desc",
      config: { definition: "result = a + b" },
    };
    const before = structuredClone(tool);
    const raw = rawToolConfiguration(tool, [agent]);
    const preview = pseudocodePreviewHtml((tool.config as { definition: string }).definition);
    expect(raw).toContain("result = a + b");
    expect(preview).toContain("result");
    expect(tool).toEqual(before);
  });
});

it('renders a compact, scrollable three-column built-in table before Custom Tools', () => {
  const html = renderToStaticMarkup(<ToolsPage agents={[]} toolRegistry={toolRegistry} />);
  expect(html).toContain('aria-label="Built-in tools"');
  expect(html).toContain('MuiTableCell-sizeSmall');
  expect(html).toContain('overflow-x:auto');
  expect(html).toContain('table-layout:fixed');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('>Name<');
  expect(html).toContain('>Type<');
  expect(html).not.toContain('>Tool ID<');
  expect(html).toContain('>Description<');
  expect(html.indexOf('aria-label="Built-in tools"')).toBeLessThan(html.indexOf('id="custom-tools-heading"'));
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(toolRegistry.listBuiltIn().length);
  expect(html).toContain('data-testid="CodeOutlinedIcon"');
  expect(html).toContain('data-testid="PublicOutlinedIcon"');
  expect(html).toContain('data-testid="LocalLibraryOutlinedIcon"');
  for (const color of [p.pinkInk, p.tealInk, p.amberInk]) expect(html.toLowerCase()).toContain(color.toLowerCase());
});

it('connects each name button to collapsed details and renders full schema or automatic Library details when expanded', () => {
  for (const tool of toolRegistry.listBuiltIn()) {
    const closed = renderToStaticMarkup(<table><tbody><BuiltInToolRow tool={tool} onToggle={() => {}} /></tbody></table>);
    expect(closed).toContain(`id="built-in-${tool.id}-name"`);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain(`aria-controls="built-in-${tool.id}-details"`);
    expect(closed).toContain('MuiCollapse-hidden');
    expect(closed).toContain('aria-hidden="true"');
    const open = renderToStaticMarkup(<table><tbody><BuiltInToolRow tool={tool} expanded onToggle={() => {}} /></tbody></table>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('MuiCollapse-entered');
    expect(open).toContain('colSpan="3"');
    expect(open).toContain(`aria-labelledby="built-in-${tool.id}-name"`);
    expect(open).toContain(tool.description);
    if (tool.inputSchema) expect(open).toContain('Input schema');
    if (tool.executionType === 'library') {
      expect(open).toContain('Runs automatically before each Manager Agent request. Not callable by the model.');
      expect(open).not.toContain('Input schema');
    }
  }
});
