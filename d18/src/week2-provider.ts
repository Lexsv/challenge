import {providerInfo} from "./provider-registry.ts";
export const week2ProviderOptions=Object.entries(providerInfo).filter(([,p])=>p.week2).map(([id,p])=>({id,label:p.label}));
export function isWeek2Provider(provider: string): boolean {
  return week2ProviderOptions.some((option) => option.id === provider);
}
export const unsupportedWeek2ProviderMessage = 'Select OpenAI or OpenCode Console in chat settings before sending. OpenCode Go is no longer available in Week 2.';
