import type { Settings, Attempt } from "./models";
export type Request = {
  settings: Settings;
  instructions: string;
  input: string;
  schema?: object;
};
export type Adapter = (
  key: string,
  request: Request,
) => Promise<Omit<Attempt, "id">>;
