/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      phaser: "phaser/dist/phaser.esm.js",
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // Dev ergonomics: let `/api/*` (including WS upgrades) hit the wrangler
    // worker on :8788 through the same origin as the Vite dev server. The
    // real client hardcodes ws://localhost:8788, so this doesn't affect
    // prod — it just unblocks tests / tools that won't talk cross-origin.
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
