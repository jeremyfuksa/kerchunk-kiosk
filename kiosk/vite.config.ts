import { defineConfig } from "vite";

export default defineConfig({
  root: "src/frontend",
  build: { outDir: "../../dist/frontend", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
