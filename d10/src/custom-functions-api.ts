export type SavedFunction = {id:string; name:string; description:string; pseudocode:string};
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/functions${path}`, init);
  if (!response.ok) throw new Error(`Function storage request failed (${response.status}).`);
  return response.json();
}
function parse(value: unknown): SavedFunction {
  if (!value || typeof value !== 'object') throw new Error('Invalid Function response.');
  const item = value as SavedFunction;
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.description !== 'string' || typeof item.pseudocode !== 'string') throw new Error('Invalid Function response.');
  return item;
}
export async function loadFunctions(): Promise<SavedFunction[]> {
  const value = await request('');
  if (!Array.isArray(value)) throw new Error('Invalid Function list.');
  return value.map(parse);
}
export async function saveFunction(item: SavedFunction, mode:'create'|'edit'): Promise<SavedFunction> {
  return parse(await request(mode === 'create' ? '' : `/${encodeURIComponent(item.id)}`, {method:mode === 'create'?'POST':'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)}));
}
export async function deleteFunction(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, {method:'DELETE'});
}
