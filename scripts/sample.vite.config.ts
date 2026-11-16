import { defineConfig } from "vite";

/** Bundles the sample builders (Coin Run, Holdout) for node. */
export default defineConfig({
  build: {
    ssr: "scripts/sample/main.ts",
    outDir: "node_modules/.sample",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
