import { defineConfig } from "vite";

/** Bundles scripts/make-icon.ts for node, so `npm run icon` needs no loader. */
export default defineConfig({
  build: {
    ssr: "scripts/make-icon.ts",
    outDir: "node_modules/.icon",
    emptyOutDir: true,
    target: "node22",
    minify: false,
  },
});
