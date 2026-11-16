import { defineConfig } from "vite";

/** Bundles the Twin Stick generator for node, the way the other samples are. */
export default defineConfig({
  build: {
    ssr: "scripts/twin-stick/build.ts",
    outDir: "node_modules/.twin-stick",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
