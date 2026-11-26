import {retryAfterMs, statusCode} from "./execution-policy.ts";
import type { ToolExecutionType } from "./tool-execution-type";

export type ToolPrimitiveType = "string" | "number" | "boolean";

export type ToolArgumentSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: ToolPrimitiveType;
      description?: string;
    }
  >;
  required: string[];
  additionalProperties?: boolean;
};

export type ToolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; details?: unknown };

export type ToolExecutionResult<T> =
  | { ok: true; toolId: string; output: T; logicalCallId?: string; outcome?: "Success" }
  | {
      ok: false;
      toolId: string;
      logicalCallId?: string;
      outcome?: "Failed" | "Skipped" | "Unknown" | "Cancelled";
      error: { code: string; message: string; details?: unknown; retryAfterMs?: number } & Partial<Omit<import("./execution-policy").ExecutionError,"code" | "message">>;
    };

export interface ExecutableTool<TArgs = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  executionType: ToolExecutionType;
  inputSchema: ToolArgumentSchema;
  validate(args: unknown): ToolValidationResult<TArgs>;
  safety?: import("./execution-policy").OperationSafety;
  independentInputs?: boolean;
  /** Derived values another call may need. Echoed input fields are excluded. */
  produces?: readonly string[];
  execute(args: TArgs, signal?: AbortSignal, idempotencyKey?: string): Promise<TOutput>;
}

export type InternalToolCatalogItem = {
  id: string;
  name: string;
  description: string;
  executable: boolean;
  kind: "built-in" | "user-defined";
  executionType?: ToolExecutionType;
  inputSchema?: ToolArgumentSchema;
};

/** Inert catalog descriptor. No transport, credentials, or execution callback. */
export type McpToolCatalogItem = {
  kind: "mcp";
  source: "mcp";
  id: string;
  toolId: string;
  connectionId: string;
  originalName: string;
  name: string;
  description: string;
  executable: true;
  executionType?: never;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type ToolCatalogItem = InternalToolCatalogItem | McpToolCatalogItem;

export type UserDefinedToolLike = {
  id: string;
  name: string;
  description: string;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ExecutableTool<unknown, unknown>>();
  private readonly libraries = new Map<string, ToolCatalogItem>();
  private readonly customTools = new Map<string, ExecutableTool<unknown, unknown>>();

  fork(): ToolRegistry {
    const copy=new ToolRegistry();
    for(const [id,tool] of this.tools)copy.tools.set(id,tool);
    for(const [id,tool] of this.customTools)copy.customTools.set(id,tool);
    for(const [id,library] of this.libraries)copy.libraries.set(id,library);
    return copy;
  }

  replaceCustomTools(tools: ExecutableTool<unknown, unknown>[]) {
    this.customTools.clear();
    for (const tool of tools) this.customTools.set(tool.id, tool);
  }

  registerLibrary(tool: Pick<ToolCatalogItem, "id" | "name" | "description">) {
    this.libraries.set(tool.id, { ...tool, executable: false, kind: "built-in", executionType: "library" });
  }

  register(tool: ExecutableTool<unknown, unknown>) {
    this.tools.set(tool.id, tool);
  }

  get(id: string) {
    return this.tools.get(id) ?? this.customTools.get(id);
  }

  listBuiltIn(): ToolCatalogItem[] {
    const executable = [...this.tools.values()].map((tool): ToolCatalogItem => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      executable: true,
      kind: "built-in",
      executionType: tool.executionType,
      inputSchema: tool.inputSchema,
    }));
    return [...executable, ...this.libraries.values()];
  }

  listWithUserTools(userTools: readonly UserDefinedToolLike[] = []): ToolCatalogItem[] {
    return [
      ...this.listBuiltIn(),
      ...userTools.map((tool) => ({
        id: `user:${tool.id}`,
        name: tool.name,
        description: tool.description,
        executable: false,
        kind: "user-defined" as const,
      })),
    ];
  }

  listExecutable(): ToolCatalogItem[] {
    return [...this.listBuiltIn(), ...[...this.customTools.values()].map((tool): ToolCatalogItem => ({
      id: tool.id, name: tool.name, description: tool.description, executable: true,
      kind: 'user-defined', executionType: tool.executionType, inputSchema: tool.inputSchema,
    }))];
  }

  async executeById(id: string, args: unknown, signal?: AbortSignal, idempotencyKey?: string): Promise<ToolExecutionResult<unknown>> {
    const tool = this.get(id);
    if (!tool) {
      return {
        ok: false,
        toolId: id,
        error: {
          code: "unknown_tool",
          message: `Tool not found: ${id}`,
        },
      };
    }
    const validation = tool.validate(args);
    if (!validation.ok) {
      return {
        ok: false,
        toolId: id,
        error: {
          code: validation.code,
          message: validation.message,
          details: validation.details,
        },
      };
    }
    try {
      const output = await tool.execute(validation.value, signal, idempotencyKey);
      return { ok: true, toolId: id, output };
    } catch (error) {
      return {
        ok: false,
        toolId: id,
        error: {
          code: error instanceof ToolTransportError && signal ? error.code : "execution_error",
          ...(error instanceof ToolTransportError && signal ? {retryAfterMs:error.retryAfterMs} : {}),
          message:
            error instanceof Error
              ? error.message
              : "Tool execution failed.",
        },
      };
    }
  }
}

const requiredNumber = (
  key: string,
  source: Record<string, unknown>,
): ToolValidationResult<number> => {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `Expected finite number for '${key}'.`,
    };
  }
  return { ok: true, value };
};

const requiredString = (
  key: string,
  source: Record<string, unknown>,
): ToolValidationResult<string> => {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `Expected non-empty string for '${key}'.`,
    };
  }
  return { ok: true, value };
};

const objectInput = (args: unknown): ToolValidationResult<Record<string, unknown>> => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: "Tool arguments must be an object.",
    };
  }
  return { ok: true, value: args as Record<string, unknown> };
};

export type TaxCalculatorArgs = {
  amount: number;
  taxRate: number;
};

export type TaxCalculatorOutput = {
  amount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
};

export const taxCalculatorTool: ExecutableTool<
  TaxCalculatorArgs,
  TaxCalculatorOutput
> = {
  safety: "read-only", independentInputs: true,
  produces: ["taxAmount", "total"],
  id: "builtin.tax_calculator",
  name: "Tax Calculator",
  description: "Calculates tax and total amount from a base amount and tax rate.",
  executionType: "function",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Base amount." },
      taxRate: { type: "number", description: "Tax rate percentage." },
    },
    required: ["amount", "taxRate"],
    additionalProperties: false,
  },
  validate(args) {
    const base = objectInput(args);
    if (!base.ok) return base;
    const amount = requiredNumber("amount", base.value);
    if (!amount.ok) return amount;
    const taxRate = requiredNumber("taxRate", base.value);
    if (!taxRate.ok) return taxRate;
    return { ok: true, value: { amount: amount.value, taxRate: taxRate.value } };
  },
  async execute(args) {
    const taxAmount = (args.amount * args.taxRate) / 100;
    return {
      amount: args.amount,
      taxRate: args.taxRate,
      taxAmount,
      total: args.amount + taxAmount,
    };
  },
};

export type CurrencyConverterArgs = {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  exchangeRate: number;
};

export type CurrencyConverterOutput = {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  exchangeRate: number;
  convertedAmount: number;
};

export const currencyConverterTool: ExecutableTool<
  CurrencyConverterArgs,
  CurrencyConverterOutput
> = {
  safety: "read-only", independentInputs: true,
  produces: ["convertedAmount"],
  id: "builtin.currency_converter",
  name: "Currency Converter",
  description: "Converts an amount using a supplied exchange rate.",
  executionType: "function",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number" },
      fromCurrency: { type: "string" },
      toCurrency: { type: "string" },
      exchangeRate: { type: "number" },
    },
    required: ["amount", "fromCurrency", "toCurrency", "exchangeRate"],
    additionalProperties: false,
  },
  validate(args) {
    const base = objectInput(args);
    if (!base.ok) return base;
    const amount = requiredNumber("amount", base.value);
    if (!amount.ok) return amount;
    const fromCurrency = requiredString("fromCurrency", base.value);
    if (!fromCurrency.ok) return fromCurrency;
    const toCurrency = requiredString("toCurrency", base.value);
    if (!toCurrency.ok) return toCurrency;
    const exchangeRate = requiredNumber("exchangeRate", base.value);
    if (!exchangeRate.ok) return exchangeRate;
    if (exchangeRate.value <= 0) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "exchangeRate must be greater than 0.",
      };
    }
    return {
      ok: true,
      value: {
        amount: amount.value,
        fromCurrency: fromCurrency.value.toUpperCase(),
        toCurrency: toCurrency.value.toUpperCase(),
        exchangeRate: exchangeRate.value,
      },
    };
  },
  async execute(args) {
    return {
      amount: args.amount,
      fromCurrency: args.fromCurrency,
      toCurrency: args.toCurrency,
      exchangeRate: args.exchangeRate,
      convertedAmount: args.amount * args.exchangeRate,
    };
  },
};

class ToolTransportError extends Error {
  readonly code: string;
  readonly retryAfterMs: number;
  constructor(message: string, code: string, retryAfterMs = 0) { super(message); this.code=code; this.retryAfterMs=retryAfterMs; }
}

export interface ExchangeRateSource {
  sourceName: string;
  getRate(fromCurrency: string, toCurrency: string, signal?: AbortSignal): Promise<number | undefined>;
}

export class HttpExchangeRateSource implements ExchangeRateSource {
  readonly sourceName = "frankfurter.app";

  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  constructor(fetcher: typeof fetch = fetch, timeoutMs = 8_000, baseUrl = "https://api.frankfurter.dev/v1") {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
  }

  async getRate(fromCurrency: string, toCurrency: string, signal?: AbortSignal): Promise<number | undefined> {
    if (fromCurrency === toCurrency) return 1;
    const normalizedBaseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL("latest", normalizedBaseUrl);
    url.searchParams.set("from", fromCurrency);
    url.searchParams.set("to", toCurrency);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal,controller.signal]) : controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new ToolTransportError(`Exchange rate request timed out after ${this.timeoutMs} ms.`, "timeout");
      }
      throw new ToolTransportError("Exchange rate provider is unavailable.", "connection");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ToolTransportError(`Exchange rate provider returned HTTP ${response.status}.`, statusCode(response.status), retryAfterMs(response.headers?.get("Retry-After") ?? null,Date.now()));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Exchange rate provider returned malformed JSON.");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Exchange rate provider returned an invalid response.");
    }
    const rates = (payload as { rates?: unknown }).rates;
    if (!rates || typeof rates !== "object") {
      throw new Error("Exchange rate response is missing rates.");
    }
    const rate = (rates as Record<string, unknown>)[toCurrency];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return undefined;
    }
    return rate;
  }
}

export class MockExchangeRateSource implements ExchangeRateSource {
  readonly sourceName = "mock-static-rates-v1";

  private readonly rates: Record<string, number> = {
    "USD:EUR": 0.92,
    "EUR:USD": 1.087,
    "USD:JPY": 156,
    "JPY:USD": 0.00641,
    "USD:GBP": 0.79,
    "GBP:USD": 1.266,
    "USD:CAD": 1.36,
  };

  async getRate(fromCurrency: string, toCurrency: string) {
    return this.rates[`${fromCurrency}:${toCurrency}`];
  }
}

export type ExchangeRateArgs = {
  fromCurrency: string;
  toCurrency: string;
};

export type ExchangeRateOutput = {
  fromCurrency: string;
  toCurrency: string;
  exchangeRate: number;
  rateSource: string;
};

export const createExchangeRateTool = (
  source: ExchangeRateSource,
): ExecutableTool<ExchangeRateArgs, ExchangeRateOutput> => ({
  safety: "read-only", independentInputs: true,
  produces: ["exchangeRate"],
  id: "builtin.exchange_rate",
  name: "Exchange Rate",
  description:
    "Fetches current exchange rates from Frankfurter; currency conversion is calculated locally.",
  executionType: "http",
  inputSchema: {
    type: "object",
    properties: {
      fromCurrency: { type: "string" },
      toCurrency: { type: "string" },
    },
    required: ["fromCurrency", "toCurrency"],
    additionalProperties: false,
  },
  validate(args) {
    const base = objectInput(args);
    if (!base.ok) return base;
    const fromCurrency = requiredString("fromCurrency", base.value);
    if (!fromCurrency.ok) return fromCurrency;
    const toCurrency = requiredString("toCurrency", base.value);
    if (!toCurrency.ok) return toCurrency;
    const normalizedFrom = fromCurrency.value.trim().toUpperCase();
    const normalizedTo = toCurrency.value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedFrom) || !/^[A-Z]{3}$/.test(normalizedTo)) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "Currency codes must contain exactly three letters (for example, USD or EUR).",
      };
    }
    return {
      ok: true,
      value: {
        fromCurrency: normalizedFrom,
        toCurrency: normalizedTo,
      },
    };
  },
  async execute(args, signal) {
    const rate = await source.getRate(args.fromCurrency, args.toCurrency, signal);
    if (rate === undefined) {
      throw new Error(
        `Unsupported currency pair: ${args.fromCurrency}/${args.toCurrency}`,
      );
    }
    return {
      fromCurrency: args.fromCurrency,
      toCurrency: args.toCurrency,
      exchangeRate: rate,
      rateSource: source.sourceName,
    };
  },
});

export function createBuiltInToolRegistry(
  source: ExchangeRateSource = new HttpExchangeRateSource(),
) {
  const registry = new ToolRegistry();
  registry.registerLibrary({ id: 'library.js-tiktoken', name: 'js-tiktoken', description: 'Estimates the complete input locally before every Manager Agent model request; records provider usage and available cost estimates.' });
  registry.register(taxCalculatorTool as ExecutableTool<unknown, unknown>);
  registry.register(currencyConverterTool as ExecutableTool<unknown, unknown>);
  registry.register(
    createExchangeRateTool(source) as ExecutableTool<unknown, unknown>,
  );
  return registry;
}
