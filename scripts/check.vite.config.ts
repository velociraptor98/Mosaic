import { defineConfig } from "vite";

/** Bundles `npm run check` for node: the editor's own open-and-save path, checked against disk. */
export default defineConfig({
  build: {
    ssr: "scripts/check/main.ts",
    outDir: "node_modules/.check",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
