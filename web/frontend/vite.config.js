import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api (and /uploads — see reslink-backend/src/uploads.js,
// where receipt photos get served back out from) to the backend so you
// don't need CORS during local development. In production, set
// VITE_API_URL instead (see .env.example) and serve the built dist/
// behind nginx, which should also proxy /uploads to the backend the
// same way (see ../deploy/).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_PROXY_TARGET || "http://localhost:4000",
        changeOrigin: true,
      },
      "/uploads": {
        target: process.env.VITE_DEV_API_PROXY_TARGET || "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
