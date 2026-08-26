import { defineConfig } from "vite";

/** Bundles the round-trip check for node, the way the other harnesses are. */
export default defineConfig({
  build: {
    ssr: "scripts/breakout/roundtrip.ts",
    outDir: "node_modules/.breakout-roundtrip",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
