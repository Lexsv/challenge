import { useState } from "react";
import { ParameterEditor } from "./parameter-editor";
import type { ApiParameter } from "./api-parameters";
import { defaultConsoleRows } from "./console-expert-parameter-rules";

export function ConsoleParameterEditor({ parameters, onChange }: { parameters: ApiParameter[]; onChange: (rows: ApiParameter[]) => void }) {
  const [rows, setRows] = useState(() => defaultConsoleRows(parameters));
  return <ParameterEditor parameters={rows} onChange={(next) => { setRows(next); onChange(next); }} />;
}
