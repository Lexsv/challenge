export type ProviderErrorMetadata = {
  kind: "context-overflow" | "authentication" | "rate-limit" | "request";
  status: number;
  code?: string;
};
export function providerError(
  status: number,
  payload: unknown,
): ProviderErrorMetadata;
