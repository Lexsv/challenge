import {parseModels, type DiscoveredModel} from './opencode-catalog';

export type CatalogStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const browserCatalogStorage = () => typeof window === 'undefined' ? undefined : window.localStorage;
const key = (endpoint: string) => `expert-lab:d8:console-catalog:${encodeURIComponent(endpoint)}`;

export function loadModelCatalog(endpoint: string, storage?: CatalogStorage): DiscoveredModel[] {
  try {
    const snapshot = JSON.parse(storage?.getItem(key(endpoint)) ?? 'null');
    return snapshot?.version === 1 ? parseModels(snapshot) : [];
  } catch {return [];}
}

// Store only the public fields used by the app, never an upstream response or
// provider configuration. Use the discovery parser again when restoring.
export function saveModelCatalog(endpoint: string, models: readonly DiscoveredModel[], storage?: CatalogStorage) {
  if (!storage) return;
  const data = models.map(model => ({
    id:model.id, name:model.name, disabled:model.disabled, available:model.available,
    modalities:{input:model.features?.input, output:model.features?.output},
    capabilities:{
      ...model.parameterSupport, structured_output:model.structuredOutput,
      tools:{supported:model.features?.tools},
      reasoning:{supported:model.features?.reasoning,levels:model.features?.reasoningLevels},
    },
    limit:{context:model.contextWindow,output:model.maxOutputTokens},
    cost:{text:{input:{price:model.price?.input,cache:{read:model.price?.cacheRead,write:model.price?.cacheWrite}},output:{price:model.price?.output}}},
  }));
  storage.setItem(key(endpoint), JSON.stringify({version:1,data}));
}
