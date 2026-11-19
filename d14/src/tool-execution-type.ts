import { palette } from "./theme";
import LocalLibraryOutlined from "@mui/icons-material/LocalLibraryOutlined";
import CodeOutlined from "@mui/icons-material/CodeOutlined";
import PublicOutlined from "@mui/icons-material/PublicOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";

export type ToolExecutionType = "function" | "http" | "agent" | "library";

export const toolExecutionTypeMeta: Record<
  ToolExecutionType,
  {
    label: string;
    color: string;
    background: string;
    icon: typeof CodeOutlined;
  }
> = {
  library: {
    label: "Library",
    color: palette.secondary.dark,
    background: palette.secondary.light,
    icon: LocalLibraryOutlined,
  },
  function: {
    label: "Function",
    color: palette.primary.dark,
    background: palette.primary.light,
    icon: CodeOutlined,
  },
  http: {
    label: "HTTP API",
    color: palette.info.main,
    background: palette.info.light,
    icon: PublicOutlined,
  },
  agent: {
    label: "Agent",
    color: palette.warning.main,
    background: palette.warning.light,
    icon: SmartToyOutlined,
  },
};
