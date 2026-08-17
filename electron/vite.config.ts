import { defineConfig } from "vite";

/**
 * Builds the main process into dist-electron/main.mjs.
 *
 * Main ships as ESM because it uses import.meta.url. The preload bridge is
 * built by vite.preload.config.ts instead, because Electron loads preload
 * scripts as CommonJS.
 */
export default defineConfig({
  // Static assets belong to the renderer bundle, not to these node bundles.
  publicDir: false,
  build: {
    outDir: "dist-electron",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    lib: {
      entry: { main: "electron/main.ts" },
      formats: ["es"],
      fileName: () => "main.mjs",
    },
    rollupOptions: { external: ["electron", "chokidar", /^node:/] },
  },
});
