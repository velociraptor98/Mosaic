import { defineConfig } from "vite";

/** Bundles the Breakout generator for node, the way the other samples are. */
export default defineConfig({
  build: {
    ssr: "scripts/breakout/build.ts",
    outDir: "node_modules/.breakout",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
