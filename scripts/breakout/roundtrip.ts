import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { projectFromSource } from "../../src/editor/project/serialize";
import { buildIndex, parseScriptFile, propertiesOf, scriptKey } from "../../src/editor/scripts/parse";
import type { ParsedFile } from "../../src/editor/scripts/parse";
import type { DiskAsset, DiskFile, ProjectSource } from "../../src/editor/platform/types";
import { resolvePrefab } from "../../src/shared/prefabs";
import { SCRIPT_EXT } from "../../src/shared/scripts";

/**
 * Opens the saved project the way the editor opens it, and checks what came
 * back.
 *
 * The other harnesses all run FORWARD: author, export, compile, play. None of
 * them re-reads the folder. But the folder is what a person actually opens, and
 * "the editor can write a project it cannot open again" is the specific failure
 * the serializer exists to prevent — so it is worth an actual check rather than
 * an assumption.
 *
 * Everything below goes through the editor's own reader: `projectFromSource` is
 * the function `Workspace.open()` calls, and the script index is built by the
 * same parser the Inspector reads its fields from.
 */

const root = resolve(process.argv[2] ?? "samples/breakout");

const results: { ok: boolean; name: string; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** The files under a folder matching a pattern, as the platform reader returns them. */
function readDirFiles(dir: string, pattern: RegExp): DiskFile[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => pattern.test(f))
    .map((f) => ({ rel: `${dir}/${f}`, contents: readFileSync(join(abs, f), "utf8") }));
}

function readAssets(dir: string): DiskAsset[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => !f.startsWith("."))
    .map((f) => ({ rel: `${dir}/${f}`, bytes: statSync(join(abs, f)).size }));
}

/** Every source file under src/, the way the script index is loaded. */
function readScripts(dir: string): ParsedFile[] {
  const out: ParsedFile[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (SCRIPT_EXT.test(entry.name)) {
        out.push(parseScriptFile(relative(root, child), readFileSync(child, "utf8")));
      }
    }
  };
  const start = join(root, dir);
  if (existsSync(start)) walk(start);
  return out.sort((a, b) => a.src.localeCompare(b.src));
}

console.log(`Round trip: reopening ${relative(process.cwd(), root)} the way Mosaic does`);

if (!existsSync(join(root, "phaser.editor.json"))) {
  console.error(`  no phaser.editor.json in ${root} — run \`npm run breakout\` first`);
  process.exit(1);
}

const source: ProjectSource = {
  root,
  manifest: readFileSync(join(root, "phaser.editor.json"), "utf8"),
  config: readFileSync(join(root, "mosaic.config.json"), "utf8"),
  scenes: readDirFiles("src/scenes", /\.scene\.json$/),
  prefabs: readDirFiles("src/prefabs", /\.prefab\.json$/),
  assets: readAssets("assets"),
  occupied: true,
};

// Asset bytes are not read here; the editor resolves them to a URL it can draw.
const { project, issues, scaffolded } = projectFromSource(source, "breakout", (rel) => rel);

check("the folder opens as an existing project", !scaffolded, scaffolded ? "was treated as empty and scaffolded over" : "not scaffolded over");
check("it opens without complaints", issues.length === 0, issues.length ? issues.join(" · ") : "no issues reported");

// ---- the scene -----------------------------------------------------------
const scene = project.scenes[0];
check("the scene comes back", project.scenes.length === 1 && !!scene, scene ? `${scene.key} · ${scene.settings.width}×${scene.settings.height}` : "no scene");
check(
  "every object survives the trip",
  scene?.objects.length === 65,
  `${scene?.objects.length ?? 0} objects`,
);
check(
  "the scene keeps what was authored on it",
  scene?.settings.gravityY === 0 && scene?.settings.backgroundColor === "#12141c",
  `gravity ${scene?.settings.gravityY}, background ${scene?.settings.backgroundColor}`,
);
const edges = scene?.settings.bounds;
check(
  "the open floor survives the trip",
  !!edges && edges.left && edges.right && edges.top && !edges.bottom,
  edges ? `left/right/top closed, bottom open` : "no world edges recorded",
);
const hud = scene?.objects.find((o) => o.name === "HUD");
check(
  "text objects keep their own settings",
  !!hud?.text && hud.text.fixed === true && hud.text.fontSize === 18,
  hud?.text ? `HUD ${hud.text.fontSize}px, pinned to camera` : "HUD has no text settings",
);

// ---- prefabs -------------------------------------------------------------
check("all six prefabs load", project.prefabs.length === 6, project.prefabs.map((p) => p.name).join(", "));

const variants = project.prefabs.filter((p) => p.base);
check(
  "the five variants are still diffs, not copies",
  variants.length === 5 && variants.every((v) => !v.root && !!v.diff),
  variants.map((v) => `${v.name}(${Object.keys(v.diff ?? {}).length})`).join(" "),
);

const red = resolvePrefab(project, "Brick_Red");
check(
  "a variant still resolves through its base",
  red?.root.texture === "breakout" &&
    red?.root.frame === "red1" &&
    red?.root.body?.immovable === true &&
    red?.root.scripts?.[0]?.props.points === 50,
  red ? `frame red1 · immovable from Brick · 50 points of its own` : "did not resolve",
);

const base = project.prefabs.find((p) => p.name === "Brick");
check(
  "the exposure contract survives",
  base?.exposed.length === 2 && base.exposed.includes("scripts.0.props.points"),
  base?.exposed.join(", ") ?? "none",
);

// ---- instances -----------------------------------------------------------
const instances = scene?.objects.filter((o) => o.prefab) ?? [];
check(
  "every brick is still a link, not a copy",
  instances.length === 60 && instances.every((o) => Object.keys(o.overrides ?? {}).length === 0),
  `${instances.length} instances, no local overrides`,
);

// ---- groups + matrix -----------------------------------------------------
check(
  "the collision groups are the ones this game has",
  project.groups.length === 3 && ["ball", "paddle", "brick"].every((g) => project.groups.includes(g)),
  project.groups.join(", "),
);

// ---- assets --------------------------------------------------------------
const sheet = project.assets.find((a) => a.key === "breakout");
check(
  "the packed sheet comes back as an atlas",
  sheet?.kind === "atlas" && sheet.width === 504,
  sheet ? `${sheet.kind} · ${sheet.width}×${sheet.height}` : "missing",
);
const frameNames = (sheet?.frames ?? []).map((f) => f.name);
check(
  "with the packer's own frame names",
  ["blue1", "red1", "paddle1", "ball1"].every((n) => frameNames.includes(n)),
  `${frameNames.length} frames`,
);
const paddleFrame = sheet?.frames?.find((f) => f.name === "paddle1");
check(
  "and the frame rectangles the document gave",
  paddleFrame?.w === 104 && paddleFrame.h === 24,
  paddleFrame ? `paddle1 is ${paddleFrame.w}×${paddleFrame.h}` : "missing",
);

// ---- the script index ----------------------------------------------------
// This is what makes the Inspector show a field at all: the class is the
// source of truth for WHAT exists, and the scene for what it is set to.
const index = buildIndex(readScripts("src"));
const expected: Record<string, string[]> = {
  PaddleController: ["edgeMargin", "followLag"],
  BallController: ["paddleName", "launchX", "launchY", "restHeight", "english"],
  Brick: ["points", "hits"],
  BreakoutDirector: ["lives", "clearBonus", "rebuildWall"],
};
for (const [name, fields] of Object.entries(expected)) {
  const cls = index.byKey.get(scriptKey(`src/scripts/${name}.ts`, name));
  const props = cls ? propertiesOf(index, cls).map((p) => p.name) : [];
  check(
    `${name}'s @property fields are readable`,
    !!cls && fields.every((f) => props.includes(f)) && props.length === fields.length,
    props.length ? props.join(", ") : "class not indexed",
  );
}

// Every script the scene references must resolve to a class that exists, or
// the Inspector shows an unresolved script instead of its fields.
const refs = new Set<string>();
for (const obj of scene?.objects ?? []) for (const s of obj.scripts ?? []) refs.add(`${s.src}::${s.class}`);
for (const prefab of project.prefabs) {
  for (const s of prefab.root?.scripts ?? []) refs.add(`${s.src}::${s.class}`);
}
const unresolved = [...refs].filter((r) => {
  const [src, cls] = r.split("::");
  return !index.byKey.get(scriptKey(src, cls));
});
check(
  "every script the project references resolves",
  unresolved.length === 0,
  unresolved.length ? unresolved.join(", ") : `${refs.size} references, all bound`,
);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`ROUND TRIP FAILED — ${failed.length} of ${results.length} checks`);
  process.exit(1);
}
console.log(`ROUND TRIP OK — ${results.length} checks`);
