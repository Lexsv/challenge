/** Blank/invalid drafts never replace the last successfully saved limit. */
export function sessionLimitOnClose(draft: string, saved: number): number {
  const value = Number(draft);
  return draft.trim() && Number.isSafeInteger(value) && value >= 0 ? value : saved;
}
