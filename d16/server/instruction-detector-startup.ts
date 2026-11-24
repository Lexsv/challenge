import { createServerInstructionDetector } from './instruction-detector-config.ts';
import { createProviderRegistry } from '../src/provider-registry.ts';

/** Server-owned switch. Disabling affects new executions, not calls already admitted. */
export function createInstructionDetectorStartup(providerId?: string, model?: string) {
  let enabled = false;
  if (providerId !== undefined || model !== undefined) {
    if (providerId !== 'openai' || !model) throw new Error('Invalid instruction detector configuration.');
    // Validate against the local server registry without reading credentials or calling a provider.
    createServerInstructionDetector({providerId,model}, createProviderRegistry(), async()=>{});
    enabled = true;
  }
  return {
    config: enabled ? Object.freeze({providerId:providerId!,model:model!}) : undefined,
    isEnabled: () => enabled,
    disable: () => { enabled = false; },
  };
}
