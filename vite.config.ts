import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  fmt: {
    ignorePatterns: ["content-research/**"],
  },
  lint: {
    ignorePatterns: ["content-research/**"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.ORBIT_DEV_API_ORIGIN ?? "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
