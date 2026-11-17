import type { ApiParameter } from "./api-parameters";

export type TemplatesByModel = Record<string, ApiParameter[]>;
export type TemplatesByProvider = Record<string, TemplatesByModel>;

export function openTemplates(saved: TemplatesByProvider, provider: string): TemplatesByModel {
  return structuredClone(saved[provider] ?? {});
}

export function switchTemplateModel(templates: TemplatesByModel, from: string, rows: ApiParameter[], to: string): { templates: TemplatesByModel; rows: ApiParameter[] } {
  const next = { ...templates, [from]: structuredClone(rows) };
  return { templates: next, rows: structuredClone(next[to] ?? []) };
}

export function saveTemplates(saved: TemplatesByProvider, provider: string, templates: TemplatesByModel, model: string, rows: ApiParameter[]): TemplatesByProvider {
  return { ...saved, [provider]: structuredClone({ ...templates, [model]: rows }) };
}

export function deleteTemplates(saved: TemplatesByProvider, provider: string): TemplatesByProvider {
  const next = { ...saved };
  delete next[provider];
  return next;
}
