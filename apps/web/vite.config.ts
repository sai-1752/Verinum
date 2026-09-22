import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const api = process.env.VITE_API_PROXY ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    // Same-origin in development: the session cookie and the Origin check behave exactly as in production.
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  preview: { port: 4173, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: {
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: { react: ["react", "react-dom", "react-router-dom"], charts: ["recharts"], query: ["@tanstack/react-query"] },
      },
    },
  },
});
