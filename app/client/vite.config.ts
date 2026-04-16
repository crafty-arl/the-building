import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wrangler `pages dev` defaults to :8788. The worker exposes /api/session
// (HTTP upgrade -> WebSocket) and any future REST endpoints under /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
