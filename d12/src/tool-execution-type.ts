import { vintagePalette as p } from "./vintage-palette";
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
    color: p.amberInk,
    background: p.yellowPale,
    icon: LocalLibraryOutlined,
  },
  function: {
    label: "Function",
    color: p.pinkInk,
    background: p.pink,
    icon: CodeOutlined,
  },
  http: {
    label: "HTTP API",
    color: p.tealInk,
    background: p.bluePale,
    icon: PublicOutlined,
  },
  agent: {
    label: "Agent",
    color: p.warning,
    background: "#FFF0D7",
    icon: SmartToyOutlined,
  },
};
