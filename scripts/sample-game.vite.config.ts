import { defineConfig } from "vite";

/** Bundles the sample-game generator for node, the way the smoke suite is. */
export default defineConfig({
  build: {
    ssr: "scripts/sample-game/build.ts",
    outDir: "node_modules/.sample-game",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
