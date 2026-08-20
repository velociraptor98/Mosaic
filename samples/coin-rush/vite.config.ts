import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5180 },
  build: { target: "es2022" },
});

// Pixel art: Phaser handles filtering; nothing extra is needed here.
