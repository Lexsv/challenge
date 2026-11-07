import { defineConfig } from "vite";

// Only these two same-origin paths are proxied; the upstream host is fixed.
export default defineConfig({
  server: {
    proxy: {
      "^/__d5_opencode_console/(chat/completions|responses|models)$": {
        target: "https://opencode.ai",
        changeOrigin: true,
        rewrite: (path) => path === "/__d5_opencode_console/models" ? "/inference/v1/models" : path.replace(/^\/__d5_opencode_console\//, "/inference/openai/v1/"),
      },
    },
  },
});
