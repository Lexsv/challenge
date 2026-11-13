import { defineConfig } from "vite";

// Provider routes use a fixed upstream; session metadata stays on the loopback backend.
export default defineConfig({
  cacheDir: ".vite",
  server: {
    proxy: {
      "^/__d5_opencode_console/(chat/completions|responses|models)$": {
        target: "https://opencode.ai",
        changeOrigin: true,
        rewrite: (path) => path === "/__d5_opencode_console/models" ? "/inference/v1/models" : path.replace(/^\/__d5_opencode_console\//, "/inference/openai/v1/"),
      },
      "/api/credentials": { target: "http://127.0.0.1:3002" },
      "/api/sessions": { target: "http://127.0.0.1:3002" },
      "/api/functions": { target: "http://127.0.0.1:3002" },
    },
  },
});
