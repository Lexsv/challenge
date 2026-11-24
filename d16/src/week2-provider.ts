export const week2ProviderOptions = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'opencode-console', label: 'OpenCode Console' },
] as const;
export function isWeek2Provider(provider: string): boolean {
  return week2ProviderOptions.some((option) => option.id === provider);
}
export const unsupportedWeek2ProviderMessage = 'Select OpenAI or OpenCode Console in chat settings before sending. OpenCode Go is no longer available in Week 2.';
