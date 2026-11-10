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
  library: { label: "Library", color: "#1B5EA8", background: "#E3EFFD", icon: LocalLibraryOutlined },
  function: {
    label: "Function",
    color: "#6954CC",
    background: "#E6E0FF",
    icon: CodeOutlined,
  },
  http: {
    label: "HTTP API",
    color: "#087F72",
    background: "#DDF3F0",
    icon: PublicOutlined,
  },
  agent: {
    label: "Agent",
    color: "#AD690B",
    background: "#FFF0D7",
    icon: SmartToyOutlined,
  },
};
