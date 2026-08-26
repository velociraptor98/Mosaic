import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundles the exported Breakout and plays it.
 *
 * The entry is a throwaway: it boots the SAME generated scene class the sample's
 * own main.ts boots, and hangs the game off `window` so the harness can reach
 * in. Nothing about the scene, the prefabs or the scripts is stubbed.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sample = join(root, "samples", "breakout");
const outDir = join(sample, "__playtest");

if (!existsSync(sample)) {
  console.error(`  ${sample} does not exist — run \`npm run breakout\` first`);
  process.exit(1);
}

const ENTRY = `import Phaser from "phaser";
import { Level_01 } from "../src/scenes/Level_01";

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  width: 800,
  height: 600,
  backgroundColor: "#12141c",
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [Level_01],
  audio: { noAudio: true },
});

window.__game = game;
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>breakout playtest</title>
<style>html,body{margin:0;background:#12141c}</style>
<body><script type="module" src="./entry.ts"></script></body>`;

const VITE_CONFIG = `import { defineConfig } from "vite";
export default defineConfig({
  root: ${JSON.stringify(outDir)},
  base: "./",
  build: { outDir: ${JSON.stringify(join(outDir, "dist"))}, emptyOutDir: true },
});
`;

console.log("Playtest (breakout): the exported game, driven in Chromium");

mkdirSync(outDir, { recursive: true });
// Vite copies <root>/public into the bundle root, so the built page resolves
// "assets/ball1.png" exactly as the generated preload() asks for it.
cpSync(join(sample, "assets"), join(outDir, "public", "assets"), { recursive: true });
writeFileSync(join(outDir, "entry.ts"), ENTRY);
writeFileSync(join(outDir, "index.html"), PAGE);
writeFileSync(join(root, "vite.playtest.config.ts"), VITE_CONFIG);

const linked = join(sample, "node_modules");
const createdLink = !existsSync(linked);
if (createdLink) symlinkSync(join(root, "node_modules"), linked, "dir");

let code = 1;
try {
  process.stdout.write("  bundling… ");
  execFileSync(
    process.execPath,
    [join(root, "node_modules/.bin/vite"), "build", "--config", join(root, "vite.playtest.config.ts")],
    { cwd: root, stdio: "pipe", encoding: "utf8" },
  );
  console.log("ok");

  const out = execFileSync(
    join(root, "node_modules/.bin/electron"),
    [
      join(root, "scripts/breakout/playtest.cjs"),
      join(outDir, "dist", "index.html"),
      join(root, "samples", "shots", "breakout.png"),
    ],
    { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  process.stdout.write(out);
  code = out.includes("PLAYTEST OK") ? 0 : 1;
} catch (err) {
  console.log("FAILED");
  process.stdout.write(err.stdout || "");
  console.error(err.stderr || "");
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(join(root, "vite.playtest.config.ts"), { force: true });
  if (createdLink) rmSync(linked, { force: true });
}

process.exit(code);
