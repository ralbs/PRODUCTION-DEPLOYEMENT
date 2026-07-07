import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // fail fast instead of silently bumping to 5174
    proxy: {
      // All /api and /graphql calls go to the backend — no CORS headers needed in dev
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/graphql": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
});
