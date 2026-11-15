import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { generateProjectFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { animationSheets } from "../../src/shared/animSheets";
import { encodePngBase64 } from "../../src/shared/png";
import { scriptFilePath } from "../../src/shared/scripts";
import { bodyForSize } from "../../src/shared/size";
import type { AssetDef, ProjectConfig } from "../../src/shared/types";

/**
 * Anim Lab — a sample built to exercise the animation feature, not to be a game.
 *
 * Every part of what the format can say about an animation is used at least
 * once, and each is used somewhere its absence would be visible:
 *
 *   - a looping walk on a plain object            (playOnSpawn, many frames)
 *   - a two-frame idle at a low frame rate        (a subset of a sheet's frames)
 *   - a spin on a PREFAB, so instances inherit it (playOnSpawn through a prefab)
 *   - a one-shot with per-frame durations         (loop off, duration override)
 *   - an animation played only from a SCRIPT      (never named by playOnSpawn)
 *
 * The last one matters most: an animation nothing declares in the scene is
 * still an animation the game has to have registered, and it is the case a
 * generator is most likely to optimise away.
 */

const CONFIG: ProjectConfig = {
  canvas: { width: 640, height: 360 },
  tile: 32,
  scale: "FIT",
  physics: "arcade",
  pixelArt: true,
};

const WALKER_SCRIPT = `import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Walks back and forth, and plays a one-shot when it turns.
 *
 * The turn animation is never named anywhere in the scene — only here — which
 * is exactly the case a generator is tempted to leave unregistered.
 */
export class Walker extends ScriptComponent {
  @property({ min: 0, max: 300, hint: "pixels per second" })
  speed = 60;

  @property({ min: 0, max: 320, label: "patrol range (px)" })
  range = 120;

  @property({ label: "walk animation" })
  walkAnim = "hero_walk";

  @property({ label: "turn animation" })
  turnAnim = "hero_turn";

  private origin = 0;
  private direction = 1;

  create(): void {
    this.origin = this.object.x;
    this.object.play(this.walkAnim);
  }

  update(dt: number): void {
    this.object.x += (this.speed * dt) / 1000 * this.direction;
    if (Math.abs(this.object.x - this.origin) < this.range) return;

    this.direction *= -1;
    this.object.setFlipX(this.direction < 0);
    // A one-shot, then back to the loop when it finishes.
    this.object.play(this.turnAnim);
    this.object.once("animationcomplete", () => this.object.play(this.walkAnim));
  }
}
`;

export function buildAnimLab(location: string, name = "Anim Lab"): { root: string; files: number } {
  const plan = planScaffold({
    ...DEFAULT_OPTIONS,
    name,
    location,
    template: "empty",
    language: "ts",
    bundler: "vite",
    git: false,
    sampleArt: true,
    config: CONFIG,
  });

  const files: string[] = [];
  const write = (rel: string, contents: string, encoding: "utf8" | "base64" = "utf8") => {
    const abs = join(plan.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, encoding);
    files.push(rel);
  };
  for (const file of plan.writes) write(file.rel, file.contents, file.encoding);

  const store = new ProjectStore(plan.project);
  const scene = store.scene!;

  store.transact("Scene settings", () => {
    scene.settings.backgroundColor = "#eef2f6";
    scene.settings.gravityY = 0;
  });

  // --- the sheets, imported as a designer would import them ---------------
  const sheets = animationSheets();
  const assets: AssetDef[] = sheets.map((sheet) => {
    write(sheet.path, encodePngBase64(sheet.bitmap), "base64");
    return {
      id: `asset-${sheet.key}`,
      key: sheet.key,
      kind: "spritesheet",
      path: sheet.path,
      url: "",
      width: sheet.bitmap.width,
      height: sheet.bitmap.height,
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      margin: 0,
      spacing: 0,
    };
  });
  store.importAssets(assets);

  // --- the animations -----------------------------------------------------
  const frames = (key: string, indices: number[], duration?: number) =>
    indices.map((i) => ({ textureKey: key, frame: String(i), ...(duration ? { duration } : {}) }));

  store.upsertAnim({ key: "hero_walk", frames: frames("hero_sheet", [0, 1, 2, 3, 4, 5, 6, 7]), fps: 12, repeat: -1 });
  // Two frames at a low rate: an idle is a subset of the same sheet.
  store.upsertAnim({ key: "hero_idle", frames: frames("hero_sheet", [0, 4]), fps: 2, repeat: -1 });
  // One-shot, with per-frame durations that override the frame rate.
  store.upsertAnim({
    key: "hero_turn",
    frames: [
      { textureKey: "hero_sheet", frame: "2", duration: 60 },
      { textureKey: "hero_sheet", frame: "6", duration: 120 },
      { textureKey: "hero_sheet", frame: "0", duration: 60 },
    ],
    fps: 10,
    repeat: 0,
  });
  // YOYO: four frames of art, seven frames of motion. The whole point of the
  // flag is that the second half is not drawn.
  store.upsertAnim({
    key: "coin_spin",
    frames: frames("coin_sheet", [0, 1, 2, 3]),
    fps: 14,
    repeat: -1,
    yoyo: true,
  });
  // A FINITE repeat: three passes, then it stops. A boolean could not say this.
  store.upsertAnim({
    key: "coin_flash",
    frames: frames("coin_sheet", [0, 4, 0, 4]),
    fps: 16,
    repeat: 2,
  });

  // --- objects ------------------------------------------------------------
  const layer = scene.layers.find((l) => l.kind === "object")!;
  store.setActiveLayer(layer.id);

  const walkerId = store.addObject({
    type: "sprite",
    name: "Walker",
    x: 200,
    y: 250,
    texture: "hero_sheet",
    frame: "0",
    body: bodyForSize({ width: 32, height: 40 }, { allowGravity: false }),
    data: {},
  })!;
  store.attachScript([walkerId], { name: "Walker", src: scriptFilePath("Walker") });
  store.setScriptProp(walkerId, 0, "speed", 70);
  store.setScriptProp(walkerId, 0, "range", 140);

  // playOnSpawn, with no script involved at all.
  store.addObject({
    type: "sprite",
    name: "Idler",
    x: 96,
    y: 250,
    texture: "hero_sheet",
    frame: "0",
    playOnSpawn: "hero_idle",
    data: {},
  });

  // --- a prefab that carries its own animation ----------------------------
  const seedId = store.addObject({
    type: "sprite",
    name: "Coin",
    x: 380,
    y: 120,
    texture: "coin_sheet",
    frame: "0",
    playOnSpawn: "coin_spin",
    body: bodyForSize({ width: 24, height: 24 }, { allowGravity: false }),
    group: "pickup",
    data: {},
  })!;
  store.setSelection([seedId]);
  store.createPrefab({ name: "SpinCoin", objectId: seedId, exposed: ["playOnSpawn"] });

  // Instances inherit the animation from the definition, and one overrides it
  // — which is what `exposed: ["playOnSpawn"]` is for.
  for (const [i, x] of [452, 524].entries()) {
    const id = store.addObject({
      type: "sprite",
      name: `Coin ${i + 2}`,
      x,
      y: 120,
      prefab: "SpinCoin",
      overrides: {},
      texture: "coin_sheet",
      data: {},
    })!;
    if (i === 1) store.setObjectProp(id, "playOnSpawn", "hero_idle", "Override animation");
  }

  // A label, so the sample says what it is when you open it.
  const titleId = store.addText("ANIM LAB", { x: 16, y: 12 })!;
  store.transact("Style title", () => {
    const t = store.scene!.objects.find((o) => o.id === titleId)!;
    t.name = "Title";
    t.originX = 0;
    t.originY = 0;
    t.text = { ...t.text!, fontSize: 16, color: "#2c455d", fixed: true };
  });

  write(scriptFilePath("Walker"), WALKER_SCRIPT);
  for (const file of projectToFiles(store.project)) write(file.rel, file.contents);
  // The same files a save writes: the layout is rewritten, and a class that is
  // "yours" is written only if the scaffold has not already put one there.
  for (const file of generateProjectFiles(store.project)) {
    if (file.owner === "yours" && files.includes(file.path)) continue;
    write(file.path, file.contents);
  }

  return { root: plan.root, files: files.length };
}

const target = process.argv[2] ?? resolve(process.cwd(), "samples");
const result = buildAnimLab(target);
console.log(`Built ${result.root} — ${result.files} files`);
