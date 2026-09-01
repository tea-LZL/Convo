import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configuredHost = process.env.TAURI_DEV_HOST;
const host = configuredHost === "localhost" || configuredHost === "127.0.0.1" ? configuredHost : undefined;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
