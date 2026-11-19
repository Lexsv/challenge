import type { SavedFunction } from './custom-functions-api';
import type { ExecutableTool, ToolValidationResult } from './tool-runtime';

type Formula = { inputs: string[]; output: string; expression: string };
export function parseFunction(source: string): Formula {
  if (source.length > 10000) throw new Error('Function definition is too long.');
  const match = source.match(/(?:^|\n)\s*Inputs:\s*\n([\s\S]*?)(?:^|\n)\s*Formula:\s*\n([\s\S]*?)(?:^|\n)\s*Output:\s*\n([\s\S]*)$/i);
  if (!match) throw new Error('Expected Inputs, Formula, and Output sections.');
  const inputs = match[1].trim().split(/\r?\n/).map(line => {
    const item = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):\s*number$/i);
    if (!item) throw new Error('Inputs must be named numbers.');
    return item[1];
  });
  if (!inputs.length || inputs.length > 32 || new Set(inputs).size !== inputs.length) throw new Error('Inputs must be unique named numbers.');
  const formula = match[2].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r]+)$/);
  const output = match[3].trim().match(/^([A-Za-z_][A-Za-z0-9_]*):\s*number$/i);
  if (!formula || !output || formula[1] !== output[1]) throw new Error('Formula and Output must name the same numeric result.');
  evaluateExpression(formula[2], inputs, {}, true);
  return {inputs, output: output[1], expression: formula[2]};
}

export function evaluateFunction(source: string, values: Record<string, unknown>): Record<string, number> {
  const {inputs, output, expression} = parseFunction(source);
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(k => !inputs.includes(k))) throw new Error('Provide only the named numeric inputs.');
  for (const name of inputs) if (typeof values[name] !== 'number' || !Number.isFinite(values[name])) throw new Error(`Expected finite number for '${name}'.`);
  return { [output]: evaluateExpression(expression, inputs, values, false) };
}

function evaluateExpression(expression: string, inputs: string[], values: Record<string, unknown>, syntaxOnly: boolean): number {
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+*/-]|\S/g) ?? [];
  if (tokens.length > 256) throw new Error('Formula is too long.');
  let pos = 0;
  const primary = (): number => {
    const token = tokens[pos++];
    if (token === '(') { const n = sum(); if (tokens[pos++] !== ')') throw new Error('Missing closing parenthesis.'); return n; }
    if (token === '+' || token === '-') { const n = primary(); return token === '-' ? -n : n; }
    if (token && /^(?:\d|\.)/.test(token)) { const n = Number(token); if (Number.isFinite(n)) return n; }
    if (token && inputs.includes(token)) return syntaxOnly ? 1 : values[token] as number;
    throw new Error('Unsupported formula syntax or unknown input.');
  };
  const product = (): number => { let n = primary(); while (tokens[pos] === '*' || tokens[pos] === '/') { const op = tokens[pos++]; const rhs = primary(); if (!syntaxOnly && op === '/' && rhs === 0) throw new Error('Division by zero.'); n = op === '*' ? n * rhs : n / rhs; } return n; };
  const sum = (): number => { let n = product(); while (tokens[pos] === '+' || tokens[pos] === '-') { const op = tokens[pos++]; const rhs = product(); n = op === '+' ? n + rhs : n - rhs; } return n; };
  const result = sum();
  if (pos !== tokens.length) throw new Error('Unsupported formula syntax.');
  if (!syntaxOnly && !Number.isFinite(result)) throw new Error('Result must be finite.');
  return result;
}

export function executableFunction(item: SavedFunction): ExecutableTool<Record<string, number>, Record<string, number>> {
  const {inputs} = parseFunction(item.pseudocode);
  return {id:item.id, name:item.name, description:`${item.name}: ${item.description}`, executionType:'function',
    inputSchema:{type:'object',properties:Object.fromEntries(inputs.map(name=>[name,{type:'number' as const}])),required:inputs,additionalProperties:false},
    validate(args: unknown): ToolValidationResult<Record<string, number>> {
      try { evaluateFunction(item.pseudocode, args as Record<string, unknown>); return {ok:true,value:args as Record<string, number>}; }
      catch(error) { return {ok:false,code:'invalid_arguments',message:error instanceof Error ? error.message : 'Invalid inputs.'}; }
    },
    async execute(args) {return evaluateFunction(item.pseudocode,args);}};
}
