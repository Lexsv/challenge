import { capabilities } from "./models";
export type LabTab = "lab" | "settings";
export function initialLabTab(key: string, model: string): LabTab {
  return key.trim() && capabilities(model)?.structuredOutput
    ? "lab"
    : "settings";
}
