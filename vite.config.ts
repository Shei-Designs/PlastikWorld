import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// Ports: PlastikCAD's dev server sits on 1430/1431, so this app takes 1440/1441
// (and 1442 for `vite preview`); the two can run and be tested side by side.
export const DEV_PORT = 1440;
export const HMR_PORT = 1441;
export const PREVIEW_PORT = 1442;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  worker: { format: "es" as const },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: HMR_PORT,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Vite turns browser-console forwarding on by itself when it sees an AI agent in the
    // environment, and that plugin is part of the dependency-cache hash: a dev server
    // started by an agent and one started from a terminal would otherwise keep
    // invalidating each other's cache. Pin it so every launch shares one cache.
    forwardConsole: false,
  },
  preview: {
    port: PREVIEW_PORT,
    strictPort: true,
  },
}));
