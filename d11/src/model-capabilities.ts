export type ModelFeatures = {
  input?: string[];
  output?: string[];
  tools?: boolean;
  reasoning?: boolean;
  reasoningLevels?: string[];
};
export type CapabilityKind = 'Video' | 'Audio' | 'Image' | 'PDF' | 'Text' | 'Reasoning' | 'Tools';
export type CapabilityRow = { kind: CapabilityKind; value: string; levels?: string[] };
const strings = (value: unknown): string[] | undefined => Array.isArray(value)
  ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim()))] : undefined;

/** Retain only the declared catalog fields; absence never implies support. */
export function parseModelFeatures(value: unknown): ModelFeatures | undefined {
  if (!value || typeof value !== 'object') return;
  const model = value as Record<string, any>;
  const input = strings(model.modalities?.input);
  const output = strings(model.modalities?.output);
  const tools = model.capabilities?.tools?.supported;
  const reasoning = model.capabilities?.reasoning?.supported;
  const reasoningLevels = strings(model.capabilities?.reasoning?.levels);
  if (input === undefined && output === undefined && typeof tools !== 'boolean' && typeof reasoning !== 'boolean') return;
  return {
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    ...(typeof tools === 'boolean' ? { tools } : {}),
    ...(typeof reasoning === 'boolean' ? { reasoning } : {}),
    ...(reasoningLevels?.length ? { reasoningLevels } : {}),
  };
}
function modality(value: string): CapabilityKind | undefined {
  const format = value.toLowerCase().replace(/^\./, '');
  if (format === 'pdf' || format === 'application/pdf') return 'PDF';
  if (format === 'image' || format.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','avif','heic','heif','svg','tiff'].includes(format)) return 'Image';
  if (format === 'video' || format.startsWith('video/') || ['mp4','webm','mov','mpeg'].includes(format)) return 'Video';
  if (format === 'audio' || format.startsWith('audio/') || ['mp3','wav','flac','aac','ogg','pcm'].includes(format)) return 'Audio';
  if (format === 'text' || format.startsWith('text/')) return 'Text';
}
export function modelCapabilityRows(features?: ModelFeatures): CapabilityRow[] {
  if (!features) return [];
  const input = new Set(features.input?.map(modality));
  const output = new Set(features.output?.map(modality));
  const rows: CapabilityRow[] = [];
  for (const kind of ['Video','Audio','Image','PDF','Text'] as const) {
    if (input.has(kind) || output.has(kind)) rows.push({kind, value: input.has(kind) && output.has(kind) ? 'Input & Output' : input.has(kind) ? 'Input' : 'Output'});
  }
  if (features.reasoning) rows.push({kind:'Reasoning',value:'Supported',levels:features.reasoningLevels});
  if (features.tools) rows.push({kind:'Tools',value:'Supported'});
  return rows;
}
export function compactCapabilities(rows: CapabilityRow[]) {
  const visible = rows.length > 3 ? rows.slice(0,2) : rows;
  return { visible, remaining: rows.length - visible.length };
}
