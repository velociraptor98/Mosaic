import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds and runs the scene-parity harness.
 *
 * Scene semantics exist twice — in `runtime/loadScene.ts`, which the play-test
 * uses, and in the code generator, which is what ships. Only the first was ever
 * executed, so the two drifted apart twice without CI noticing, and both times
 * the symptom was that the editor showed behaviour the built game did not have.
 *
 * This writes a throwaway entry into the sample project that boots the SAME
 * scene both ways, bundles it, runs it in Electron, and diffs what each one
 * produced. Electron is already a dependency and is real Chromium, so Phaser
 * runs for real rather than against a mocked canvas.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sampleName = process.argv[2] || "coin-rush";
const sample = join(root, "samples", sampleName);
const outDir = join(sample, "__parity");

if (!existsSync(sample)) {
  console.error(`  ${sample} does not exist — run \`npm run sample\` first`);
  process.exit(1);
}

const ENTRY = `import Phaser from "phaser";
import manifest from "../phaser.editor.json";
import sceneData from "../src/scenes/Level_01.scene.json";
import { Level_01 } from "../src/scenes/Level_01";
import { bootLoaderScene, readAfterFrame, diff } from "../../../scripts/parity/probe";

// The manifest ships asset metadata, never bytes. Point every asset at the
// file beside it so the loader path resolves exactly what the generated
// preload() resolves.
const project = { ...manifest, assets: manifest.assets.map((a) => ({ ...a, url: a.path })) };

const results = {};
const done = () => {
  if (results.loader && results.generated) {
    window.__parity = { differences: diff(results.loader, results.generated), ...results };
  }
};

bootLoaderScene(project, sceneData, (reading) => {
  results.loader = reading;
  done();
});

// The generated class, booted the way the scaffold's main.ts boots it.
class Probe extends Level_01 {
  create() {
    super.create();
    // The loader is booted without script classes, so it runs none. Detaching
    // here keeps the comparison about what each PATH built, not about what a
    // script did to it afterwards.
    if (this.scripts) for (const child of [...this.children.list]) this.scripts.remove(child);
    readAfterFrame(this, (reading) => {
      results.generated = reading;
      done();
    });
  }
}

new Phaser.Game({
  type: Phaser.CANVAS,
  width: sceneData.settings.width,
  height: sceneData.settings.height,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [Probe],
  audio: { noAudio: true },
});
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>parity</title>
<body><script type="module" src="./entry.ts"></script></body>`;

const VITE_CONFIG = `import { defineConfig } from "vite";
export default defineConfig({
  root: ${JSON.stringify(outDir)},
  base: "./",
  build: { outDir: ${JSON.stringify(join(outDir, "dist"))}, emptyOutDir: true },
});
`;

console.log(`Scene parity (${sampleName}): loader path vs generated path`);

mkdirSync(outDir, { recursive: true });
// Vite copies <root>/public into the bundle root, so the built page resolves
// "assets/shape-star.png" exactly as the generated preload() expects.
cpSync(join(sample, "assets"), join(outDir, "public", "assets"), { recursive: true });
writeFileSync(join(outDir, "entry.ts"), ENTRY);
writeFileSync(join(outDir, "index.html"), PAGE);
writeFileSync(join(root, "vite.parity.config.ts"), VITE_CONFIG);

const linked = join(sample, "node_modules");
const createdLink = !existsSync(linked);
if (createdLink) symlinkSync(join(root, "node_modules"), linked, "dir");

let code = 1;
try {
  process.stdout.write("  bundling… ");
  execFileSync(
    process.execPath,
    [join(root, "node_modules/.bin/vite"), "build", "--config", join(root, "vite.parity.config.ts")],
    { cwd: root, stdio: "pipe", encoding: "utf8" },
  );
  console.log("ok");

  process.stdout.write("  running… ");
  const out = execFileSync(
    join(root, "node_modules/.bin/electron"),
    [join(root, "scripts/parity/main.cjs"), join(outDir, "dist", "index.html")],
    { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  console.log("ok");
  process.stdout.write(out.replace(/^/gm, "  "));
  code = out.includes("PARITY OK") ? 0 : 1;
} catch (err) {
  console.log("FAILED");
  console.error((err.stdout || "") + (err.stderr || ""));
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(join(root, "vite.parity.config.ts"), { force: true });
  if (createdLink) rmSync(linked, { force: true });
}

process.exit(code);
