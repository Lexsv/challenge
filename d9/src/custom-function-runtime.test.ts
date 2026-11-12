import { describe, expect, it } from 'vitest';
import { evaluateFunction, executableFunction, parseFunction } from './custom-function-runtime';
import { createBuiltInToolRegistry } from './tool-runtime';

const pseudocode = 'Name: sum\n\nInputs:\n  a: number\n  b: number\n\nFormula:\n  result = a + b\n\nOutput:\n  result: number';
const item = {id:'stable-test-id',name:'sum',description:'Add two numbers',pseudocode};
describe('custom Functions', () => {
  it('evaluates numeric inputs using arithmetic precedence and parentheses', () => {
    expect(evaluateFunction(pseudocode,{a:2,b:2})).toEqual({result:4});
    expect(evaluateFunction(pseudocode.replace('a + b','-(a + b) * 2 / 4'),{a:2,b:2})).toEqual({result:-2});
  });
  it('rejects unsupported syntax, invalid inputs, division by zero, and non-finite results', () => {
    expect(() => parseFunction(pseudocode.replace('a + b', 'a ** b'))).toThrow('Unsupported formula syntax');
    expect(() => parseFunction(pseudocode.replace('a + b', 'a + missing'))).toThrow('unknown input');
    expect(() => parseFunction(pseudocode.replace('a + b', 'a / (b - b)'))).not.toThrow();
    expect(() => evaluateFunction(pseudocode,{a:'2',b:2})).toThrow();
    expect(() => evaluateFunction(pseudocode,{a:2,b:2,extra:1})).toThrow();
    expect(() => evaluateFunction(pseudocode.replace('a + b','a / (b - b)'),{a:2,b:2})).toThrow();
    expect(() => evaluateFunction(pseudocode.replace('a + b','a ** b'),{a:2,b:2})).toThrow();
    expect(() => evaluateFunction(pseudocode.replace('a + b','a * b'),{a:1e308,b:1e308})).toThrow();
    expect(() => parseFunction(pseudocode.replace('result: number','other: number'))).toThrow();
  });
  it('registers, updates, and removes saved tools without changing their stable IDs', async () => {
    const registry = createBuiltInToolRegistry();
    registry.replaceCustomTools([executableFunction(item)]);
    expect(registry.listExecutable().find(tool=>tool.id===item.id)?.inputSchema?.required).toEqual(['a','b']);
    expect(await registry.executeById(item.id,{a:2,b:2})).toMatchObject({ok:true,toolId:item.id,output:{result:4}});
    registry.replaceCustomTools([executableFunction({...item,name:'renamed'})]);
    expect(registry.get(item.id)?.name).toBe('renamed');
    registry.replaceCustomTools([]);
    expect((await registry.executeById(item.id,{a:2,b:2})).ok).toBe(false);
  });
});
