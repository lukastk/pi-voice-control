import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7890",
      "/events": {
        target: "http://localhost:7890",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:7890",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
