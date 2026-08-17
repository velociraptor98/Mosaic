import { defineConfig } from "vite";

/** Preload is built separately because Electron loads it as CommonJS. */
export default defineConfig({
  // Static assets belong to the renderer bundle, not to these node bundles.
  publicDir: false,
  build: {
    outDir: "dist-electron",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    lib: {
      entry: { preload: "electron/preload.ts" },
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: { external: ["electron", /^node:/] },
  },
});
