import { execFileSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compiles an exported project.
 *
 * Export is the whole value proposition — Mosaic emits Phaser code you own —
 * and it was the least-exercised path in the repo: the first time anyone
 * compiled an export it produced three errors, one of which broke EVERY
 * project the scaffold writes. Nothing downstream of the generator was
 * checked, because nothing downstream of the generator was ever run.
 *
 * So this runs it. `npm run sample` writes a real project with the editor's
 * own code; this typechecks and bundles it against real Phaser and fails loudly
 * if either breaks.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sample = join(root, "samples", process.argv[2] || "coin-rush");

function run(label, file, args, cwd) {
  process.stdout.write(`  ${label}… `);
  try {
    execFileSync(file, args, { cwd, stdio: "pipe", encoding: "utf8" });
    console.log("ok");
    return true;
  } catch (err) {
    console.log("FAILED");
    console.error((err.stdout || "") + (err.stderr || ""));
    return false;
  }
}

console.log(`Verifying the exported sample compiles: ${process.argv[2] || "coin-rush"}`);

if (!existsSync(sample)) {
  console.error(`  ${sample} does not exist — run \`npm run sample\` first`);
  process.exit(1);
}

// The sample has no node_modules of its own; it borrows the repo's Phaser and
// TypeScript rather than making CI wait on a second install.
const linked = join(sample, "node_modules");
const created = !existsSync(linked);
if (created) symlinkSync(join(root, "node_modules"), linked, "dir");

let ok = true;
try {
  ok = run("typecheck", process.execPath, [join(root, "node_modules/.bin/tsc"), "--noEmit"], sample) && ok;
  ok = run("bundle", process.execPath, [join(root, "node_modules/.bin/vite"), "build"], sample) && ok;
} finally {
  if (created) rmSync(linked, { force: true });
  rmSync(join(sample, "dist"), { recursive: true, force: true });
}

if (!ok) {
  console.error("\nThe exported project does not compile. The generator emitted code that does not build.");
  process.exit(1);
}
console.log("Exported project compiles and bundles");
