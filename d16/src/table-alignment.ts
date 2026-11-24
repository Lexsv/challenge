/** Shared alignment for data tables, including editable table-cell contents. */
export const centeredTable = {
  "&& th, && td": { textAlign: "center", verticalAlign: "middle" },
  "&& .MuiInputBase-input": { textAlign: "center" },
} as const;
