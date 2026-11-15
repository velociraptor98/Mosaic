import { defineConfig } from "vite";

/** Bundles the Anim Lab generator for node. */
export default defineConfig({
  build: {
    ssr: "scripts/sample-game/anim-lab.ts",
    outDir: "node_modules/.anim-lab",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
