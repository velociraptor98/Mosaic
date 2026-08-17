import { defineConfig } from "vite";

/** Bundles scripts/smoke.ts for node so the editor's logic can be run headlessly. */
export default defineConfig({
  build: {
    ssr: "scripts/smoke.ts",
    outDir: "node_modules/.smoke",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
