import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { generateProjectFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { makeTemplateMap, shapeSize } from "../../src/editor/store/templates";
import { shapeTextureKey } from "../../src/shared/definitions";
import { bodyForSize } from "../../src/shared/size";
import { scriptFilePath } from "../../src/shared/scripts";
import type { ProjectConfig } from "../../src/shared/types";
import { renderGuide } from "./guide";
import { GAME_SCRIPTS } from "./scripts";

/**
 * Builds the Coin Rush sample by driving the editor.
 *
 * Every byte this writes comes out of the editor's own code: `planScaffold`
 * plans the folder, `ProjectStore` performs each edit as a real undoable
 * transaction, and `projectToFiles` / `generateProjectFiles` write the result. There
 * is no second, script-only path into the project format — if the editor
 * cannot express something, neither can this.
 *
 * Every step appends to a log, and the build guide is printed FROM that log,
 * so the document and the game are produced by one pass.
 */

export interface BuildStep {
  /** "3" / "3.1" — the numbering the guide prints. */
  n: string;
  title: string;
  /** What was done, and why it is done that way. */
  body: string;
  /** The editor action, as a reader would perform it. */
  editor?: string;
  /** The store call the editor makes underneath. */
  api?: string;
}

export interface BuildResult {
  root: string;
  steps: BuildStep[];
  files: { rel: string; bytes: number }[];
  stats: {
    objects: number;
    coins: number;
    gold: number;
    spikes: number;
    prefabs: number;
    tiles: number;
    scripts: number;
    undoDepth: number;
  };
}

const CONFIG: ProjectConfig = {
  canvas: { width: 960, height: 540 },
  tile: 32,
  scale: "FIT",
  physics: "arcade",
  pixelArt: true,
};

/** The scene's own class: the one place the game says how its objects meet. */
const LEVEL_SCENE = `import Phaser from "phaser";
import { createLevel_01, preloadLevel_01, type Level_01Layout } from "./Level_01.layout";

/**
 * Level 01 — this file is yours. Mosaic wrote the first version and will not
 * touch it again; what the editor places arrives through ./Level_01.layout.ts.
 */
export class Level_01 extends Phaser.Scene {
  layout!: Level_01Layout;

  constructor() {
    super("Level_01");
  }

  preload(): void {
    preloadLevel_01(this);
  }

  create(): void {
    this.layout = createLevel_01(this);
    const { player, terrain } = this.layout;
    this.physics.add.collider(player, terrain);
  }
}
`;

/** Tile indices from the built-in placeholder tileset. 1 and 4 collide. */
const STONE = 1;
const WALL = 4;

/** The level, as a grid of platforms: [row, firstCol, lastCol, tile]. */
const PLATFORMS: [number, number, number, number][] = [
  [15, 0, 29, WALL], // ground
  [16, 0, 29, WALL],
  [12, 3, 8, STONE],
  [9, 10, 18, STONE],
  [12, 22, 27, STONE],
  [6, 7, 12, STONE],
];

/** Coins: [x, y, gold]. y places the coin just above the surface under it. */
const COINS: [number, number, boolean][] = [
  [260, 460, false],
  [340, 460, false],
  [620, 460, false],
  [700, 460, false],
  [144, 364, false],
  [208, 364, false],
  [432, 268, false],
  [496, 268, false],
  [560, 268, false],
  [752, 364, false],
  [816, 364, false],
  [272, 172, true],
  [352, 172, true],
];

/** Spikes: [x, y]. */
const SPIKES: [number, number][] = [
  [460, 462],
  [540, 462],
  [784, 366],
];

/**
 * Placing an asset, the way the Place tool does: art, and nothing else. What
 * the object IS comes from the components put on it, and from the prefab it is
 * eventually promoted into.
 */
function placed(shape: string, group?: string) {
  return { type: "sprite", texture: shapeTextureKey(shape), group, data: {} };
}

/** A body that matches the art. */
function body(shape: string, patch: Parameters<typeof bodyForSize>[1] = {}) {
  return bodyForSize(shapeSize(shape), patch);
}

export function buildSampleGame(location: string, name = "Coin Rush"): BuildResult {
  const steps: BuildStep[] = [];
  const step = (s: BuildStep) => steps.push(s);

  // ---------------------------------------------------------------- 1. folder
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

  step({
    n: "1",
    title: "Make the project folder",
    body:
      `New project… plans the whole folder before it writes a byte of it: ${plan.writes.length} files, ` +
      `listed on the review step so nothing arrives unannounced. The EMPTY template is the right ` +
      `start here — the platformer template ships a level, and this game wants its own.\n\n` +
      `The canvas is ${CONFIG.canvas.width} × ${CONFIG.canvas.height} on a ${CONFIG.tile}px grid, which is one screen ` +
      `exactly. A hypercasual round should be legible at a glance, so the level never scrolls.`,
    editor: `New project… → name "${name}", template Empty, TypeScript, Vite`,
    api: `planScaffold({ name: "${name}", template: "empty", language: "ts", bundler: "vite" })`,
  });

  const files: { rel: string; bytes: number }[] = [];
  const write = (rel: string, contents: string, encoding: "utf8" | "base64" = "utf8") => {
    const abs = join(plan.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, encoding);
    files.push({ rel, bytes: Buffer.from(contents, encoding).byteLength });
  };
  for (const file of plan.writes) write(file.rel, file.contents, file.encoding);

  // The store is the editor: from here on every change is a real transaction
  // on a real undo stack, exactly as if it had been clicked.
  const store = new ProjectStore(plan.project);
  const scene = store.scene!;

  // ------------------------------------------------------------- 2. gravity
  store.transact("Scene settings", () => {
    scene.settings.gravityY = 900;
    scene.settings.backgroundColor = "#eef2f6";
  });
  step({
    n: "2",
    title: "Give the scene gravity",
    body:
      `The empty template starts at zero gravity, which is right for a top-down game and wrong for ` +
      `this one. 900 is a fall that feels weighty at this scale without being twitchy.\n\n` +
      `Gravity is SCENE data, not a constant in anyone's code — the exported game reads it from the ` +
      `same field the editor writes.`,
    editor: "Inspector → Scene → Gravity Y = 900",
    api: `scene.settings.gravityY = 900`,
  });

  // -------------------------------------------------------------- 3. terrain
  // Terrain is a Tiled map. The editor does not paint tiles; it places a map
  // somebody drew. Here the map is written from a grid, the same way a
  // template's starter terrain is, and is an ordinary .tmj from then on.
  const cols = Math.round(CONFIG.canvas.width / CONFIG.tile);
  const rows = Math.round(CONFIG.canvas.height / CONFIG.tile);
  const grid = Array.from({ length: rows }, () => Array<number>(cols).fill(-1));
  let painted = 0;
  for (const [row, from, to, tile] of PLATFORMS) {
    for (let col = from; col <= to; col++) {
      if (row < rows && col < cols) {
        grid[row][col] = tile;
        painted += 1;
      }
    }
  }
  const map = makeTemplateMap(scene.key, [{ name: "Terrain", data: grid }], {
    cols,
    rows,
    tile: CONFIG.tile,
  });
  store.importAssets([map]);
  store.hydrateTilemaps();
  // Its layers go in at the bottom of the list, under the objects that stand
  // on them — layer order is draw order.
  store.addTilemap(map.key);

  step({
    n: "3",
    title: "Bring in the terrain",
    body:
      `The level is a Tiled map: one tile layer, ${painted} tiles, a floor across the bottom and ` +
      `four ledges above it. Mosaic does not paint tiles — Tiled does, and Phaser already loads ` +
      `what Tiled saves — so the editor's job is to place the map and show it.\n\n` +
      `Which tiles are solid is said in Tiled too, as a "collides" property on the tile, so stone ` +
      `is solid everywhere it is ever used. The map's layer lands at the bottom of the layer list, ` +
      `under the objects, because layer order IS draw order and becomes the Phaser depth.`,
    editor: "Inspector → Map → + Import (or drop the .tmj into assets/) → Add to scene",
    api: `store.addTilemap(${JSON.stringify(map.key)})   // ${map.path}`,
  });

  // --------------------------------------------------------- 4. player + spawn
  const objectLayer = scene.layers.find((l) => l.kind === "object")!;
  store.setActiveLayer(objectLayer.id);

  const playerId = store.addObject({
    type: "player",
    name: "Player",
    x: 96,
    y: 460,
    ...placed("capsule", "player"),
    body: body("capsule", { allowGravity: true }),
  })!;
  store.attachScript([playerId], {
    name: "RunnerController",
    src: scriptFilePath("RunnerController"),
  });
  store.setScriptProp(playerId, 0, "moveSpeed", 230);
  store.setScriptProp(playerId, 0, "jumpVelocity", -470);
  store.setScriptProp(playerId, 0, "coyoteMs", 120);

  const spawnId = store.addObject({
    type: "spawn",
    name: "Spawn",
    x: 96,
    y: 460,
    ...placed("diamond"),
  })!;
  store.attachScript([spawnId], {
    name: "GameDirector",
    src: scriptFilePath("GameDirector"),
  });
  store.setScriptProp(spawnId, 0, "roundSeconds", 30);
  store.setScriptProp(spawnId, 0, "targetScore", 150);

  step({
    n: "4",
    title: "Place the player, and the object that owns the round",
    body:
      `Two objects. The Player carries RunnerController; the Spawn Point carries GameDirector.\n\n` +
      `Putting the round's rules on the spawn marker is deliberate: the one object that means ` +
      `"the round starts here" is also the one that owns how long it lasts and what winning is. ` +
      `The director hides its own marker at runtime, so the diamond is an editing aid rather than ` +
      `scenery.\n\n` +
      `The values set here — 230 speed, -470 jump, a 30 second round, 150 to win — land in the ` +
      `SCENE FILE, not in the classes. Tuning the game never means editing code.`,
    editor: "Place tool (B) → Player and Spawn Point · Scripts tab → + Add · set the fields",
    api:
      `store.addObject({ type: "sprite", texture: "shape-capsule", group: "player", x: 96, y: 460 })\n` +
      `store.attachScript([playerId], { name: "RunnerController", src: "src/scripts/RunnerController.ts" })\n` +
      `store.setScriptProp(playerId, 0, "jumpVelocity", -470)`,
  });

  // ------------------------------------------------------- 5. the Coin prefab
  const seedCoinId = store.addObject({
    type: "coin",
    name: "Coin",
    x: COINS[0][0],
    y: COINS[0][1],
    ...placed("star", "pickup"),
    body: body("star", { allowGravity: false }),
  })!;
  store.attachScript([seedCoinId], {
    name: "Collectible",
    src: scriptFilePath("Collectible"),
  });
  store.setScriptProp(seedCoinId, 0, "points", 10);

  store.setSelection([seedCoinId]);
  const coinPrefab = store.createPrefab({
    name: "Coin",
    objectId: seedCoinId,
    exposed: [],
    keepAsInstance: true,
  })!;

  step({
    n: "5",
    title: "Promote one coin into a prefab",
    body:
      `A prefab starts as something already on screen. One coin is built in the scene — sprite, ` +
      `circle body with gravity off, Collectible attached — and then promoted.\n\n` +
      `Promoting rewrites that scene node IN PLACE, keeping its id, so it becomes the first ` +
      `instance rather than being replaced by a copy of itself. The definition lands in ` +
      `src/prefabs/Coin.prefab.json as a file of its own, with its own history in the repo.`,
    editor: "Select the coin → Prefab tab → Create prefab from selection…",
    api: `store.createPrefab({ name: "Coin", objectId: seedCoinId, exposed: [], keepAsInstance: true })`,
  });

  // ------------------------------------------------------------- 6. exposure
  store.openPrefab("Coin");
  const pointsPath = "scripts.0.props.points";
  store.toggleExposed(pointsPath);
  store.pushPrefabSave();
  store.closePrefab();

  step({
    n: "6",
    title: "Expose exactly one field",
    body:
      `Prefab edit mode opens Coin.prefab alone on an empty stage, so nothing dragged there can ` +
      `land in a level. Its Expose list is the contract with the levels: a checked field is ` +
      `editable per instance, an unchecked one never appears in a level inspector at all.\n\n` +
      `Only ${pointsPath} is published — read in the list as ` +
      `"Collectible.points". Everything else about a coin is the definition's, which is what ` +
      `keeps thirteen coins from drifting into thirteen different objects. If a coin should ever ` +
      `be worth more, that is a number; if it should look different, that is a variant.`,
    editor: "Prefab tab → Expose → tick Collectible.points → Save prefab… → Push",
    api: `store.openPrefab("Coin")\nstore.toggleExposed("${pointsPath}")\nstore.pushPrefabSave()`,
  });

  // -------------------------------------------------------------- 7. variant
  store.createVariant("Coin", "Coin_Gold");
  store.openPrefab("Coin_Gold");
  const goldRoot = store.prefabDoc!.rootId;
  store.setObjectProp(goldRoot, "scaleX", 1.45, "Set scale");
  store.setObjectProp(goldRoot, "scaleY", 1.45, "Set scale");
  store.setObjectProp(goldRoot, pointsPath, 50, "Set points");
  const goldDiff = Object.keys(store.prefabDocDef()?.diff ?? {});
  store.pushPrefabSave();
  store.closePrefab();

  step({
    n: "7",
    title: "Make the gold coin a variant, not a second prefab",
    body:
      `Coin_Gold inherits Coin and states only what differs: ${goldDiff.join(", ")}. ` +
      `Its file holds a base and a diff — there is no second copy of the object anywhere.\n\n` +
      `That is the whole reason to bother. Changing the bob, the body or the art on Coin reaches ` +
      `the gold coins too; the only things they keep for themselves are the three they asked for. ` +
      `A second prefab would have been a second thing to remember to fix.`,
    editor: "Prefab tab → Variants → name Coin_Gold → Create → edit it → Save prefab…",
    api:
      `store.createVariant("Coin", "Coin_Gold")\n` +
      `store.openPrefab("Coin_Gold")\n` +
      `store.setObjectProp(root, "scaleX", 1.45)\n` +
      `store.setObjectProp(root, "${pointsPath}", 50)`,
  });

  // ------------------------------------------------------- 8. the Spike prefab
  const seedSpikeId = store.addObject({
    type: "enemy",
    name: "Spike",
    x: SPIKES[0][0],
    y: SPIKES[0][1],
    ...placed("triangle", "hazard"),
    body: body("triangle", { allowGravity: false, immovable: true }),
  })!;
  store.attachScript([seedSpikeId], { name: "Hazard", src: scriptFilePath("Hazard") });
  store.setScriptProp(seedSpikeId, 0, "timePenalty", 3);
  store.setSelection([seedSpikeId]);
  store.createPrefab({
    name: "Spike",
    objectId: seedSpikeId,
    exposed: [],
    keepAsInstance: true,
  });
  store.openPrefab("Spike");
  store.toggleExposed("scripts.0.props.timePenalty");
  store.pushPrefabSave();
  store.closePrefab();

  step({
    n: "8",
    title: "The same again for the spike",
    body:
      `Spike is built the same way: an object with an immovable body and Hazard attached, promoted ` +
      `to a prefab, with timePenalty exposed so one nastier spike is a number rather than a new ` +
      `kind of object.\n\n` +
      `A spike costs seconds instead of a life. In a thirty-second round that is enough to matter ` +
      `and never enough to feel like the game ended on you.`,
    editor: "Select the spike → Create prefab from selection… → Expose Hazard.timePenalty",
    api: `store.createPrefab({ name: "Spike", objectId: seedSpikeId, exposed: [] })`,
  });

  // ------------------------------------------------------------ 9. place them
  let coinCount = 1; // the seed coin is already an instance
  let goldCount = 0;
  for (const [x, y, gold] of COINS.slice(1)) {
    store.addObject({
      type: coinPrefab.root!.type,
      name: gold ? "Coin_Gold" : "Coin",
      x,
      y,
      prefab: gold ? "Coin_Gold" : "Coin",
      overrides: {},
      texture: coinPrefab.root!.texture,
      data: {},
    });
    if (gold) goldCount += 1;
    else coinCount += 1;
  }

  let spikeCount = 1;
  for (const [x, y] of SPIKES.slice(1)) {
    store.addObject({
      type: "sprite",
      name: "Spike",
      x,
      y,
      prefab: "Spike",
      overrides: {},
      texture: shapeTextureKey("triangle"),
      data: {},
    });
    spikeCount += 1;
  }

  step({
    n: "9",
    title: "Place the instances",
    body:
      `${coinCount} coins, ${goldCount} gold ones on the highest ledge, and ${spikeCount} spikes. ` +
      `Each is a node referencing a definition with an empty overrides map — a link, not a copy.\n\n` +
      `The gold pair is the whole risk-and-reward shape of the round: ${coinCount * 10} points sit ` +
      `on the easy route and the target is 150, so clearing it means making the climb.`,
    editor: "Asset dock → click Coin / Coin_Gold / Spike → Place tool (B) → click the canvas",
    api: `store.addObject({ type: "sprite", prefab: "Coin_Gold", x, y, overrides: {} })`,
  });

  // ------------------------------------------------------------- 10. the HUD
  const hudId = store.addText("SCORE 0 / 150", { x: 16, y: 14 })!;
  store.transact("Style HUD", () => {
    const hud = store.scene!.objects.find((o) => o.id === hudId)!;
    hud.name = "HUD";
    hud.originX = 0;
    hud.originY = 0;
    hud.text = { ...hud.text!, fontSize: 18, color: "#1d2d3d", fixed: true };
  });
  const bannerId = store.addText("", { x: 480, y: 250 })!;
  store.transact("Style banner", () => {
    const banner = store.scene!.objects.find((o) => o.id === bannerId)!;
    banner.name = "Banner";
    banner.text = { ...banner.text!, fontSize: 28, align: "center", fixed: true };
  });

  step({
    n: "10",
    title: "Author the HUD as text objects",
    body:
      `The score readout and the end-of-round banner are objects in the scene, positioned on the ` +
      `canvas like everything else. Both are PINNED TO THE CAMERA, which is what makes them a HUD: ` +
      `they stay where you put them however far the level scrolls.\n\n` +
      `The director finds them by name and writes into them. It does not create them — where the ` +
      `score sits and what size it is are content decisions, and content belongs in the scene.`,
    editor: "Toolbar → Text (T) · Inspector → Text → pin to camera",
    api: `store.addText("SCORE 0 / 150", { x: 16, y: 14 })\nhud.text = { ...hud.text, fixed: true }`,
  });

  // ------------------------------------------------------------ 11. camera
  store.transact("Camera settings", () => {
    store.scene!.settings.camera = {
      follow: "Player",
      lerpX: 0.12,
      lerpY: 0.12,
      zoom: 1,
      clampToBounds: true,
      deadzoneWidth: 220,
      deadzoneHeight: 140,
    };
  });
  step({
    n: "11",
    title: "Point the camera at the player",
    body:
      `One screen does not need to scroll, but the camera is scene data either way — a soft follow ` +
      `with a deadzone gives the level a little life without the whole screen shifting under every ` +
      `step.\n\n` +
      `Lerp 0.12 trails well behind the target; the 220 × 140 deadzone is a box in the middle the ` +
      `player can move inside before the camera bothers to follow at all. Both are numbers in the ` +
      `Scene tab, not lines in create().`,
    editor: "Inspector → Scene → Camera → follow Player, lerp 0.12, deadzone 220 × 140",
    api: `scene.settings.camera = { follow: "Player", lerpX: 0.12, deadzoneWidth: 220 }`,
  });

  // ----------------------------------------------------------- 12. collisions
  // Not an edit in the editor at all: what collides with what is the scene's
  // own code, written against what the layout hands back.
  write("src/scenes/Level_01.ts", LEVEL_SCENE);

  step({
    n: "12",
    title: "Say what collides, in the scene's own code",
    body:
      `The layout places the player and the terrain and hands both back by name. Making one stand ` +
      `on the other is a line of ordinary Phaser in the scene class — a file Mosaic wrote once and ` +
      `will not open again.\n\n` +
      `Coins and spikes need no line here: each registers its own overlap with the player from its ` +
      `script, which is where that behaviour lives.`,
    editor: "your editor → src/scenes/Level_01.ts",
    api: `this.physics.add.collider(player, terrain)`,
  });

  // ------------------------------------------------------------- 11. scripts
  for (const script of GAME_SCRIPTS) {
    write(scriptFilePath(script.name), script.source);
  }
  step({
    n: "13",
    title: "Write the four classes",
    body:
      `Mosaic never edits class source — it reads @property declarations out of it and renders ` +
      `them, and the values land in the scene. The four files are written into src/scripts/ and ` +
      `the editor indexes them; the fields set back in steps 4 to 8 are already waiting for them.\n\n` +
      `Nothing here reaches for another script. Coins and spikes emit scene events, and the ` +
      `director listens — so a coin does not need to know that a score exists.`,
    editor: "Scripts tab → + Add → Create script… (or write the file; the watcher re-indexes)",
    api: GAME_SCRIPTS.map((s) => scriptFilePath(s.name)).join("\n"),
  });

  // ------------------------------------------------------------- 12. write it
  for (const file of projectToFiles(store.project)) write(file.rel, file.contents);
  // The same files a save writes: the layout is rewritten, and a class that is
  // "yours" is written only if the scaffold has not already put one there.
  for (const file of generateProjectFiles(store.project)) {
    if (file.owner === "yours" && files.some((f) => f.rel === file.path)) continue;
    write(file.path, file.contents);
  }

  step({
    n: "14",
    title: "Save — the layout is written with it",
    body:
      `Saving writes plain JSON: the manifest, the scene, and one file per prefab under ` +
      `src/prefabs/. There is no proprietary project file — the repo can read all of it.\n\n` +
      `The same save writes a *.layout.ts beside each: generated, rewritten every time, never ` +
      `edited. The scene class and the prefab classes are written once and are yours from then ` +
      `on. The layout CONSTRUCTS the prefab classes, so behaviour written on one actually runs.`,
    editor: "⌘S — or nothing at all: the folder autosaves",
    api: `projectToFiles(store.project)\ngenerateProjectFiles(store.project)`,
  });

  return {
    root: plan.root,
    steps,
    files,
    stats: {
      objects: store.scene!.objects.length,
      coins: coinCount,
      gold: goldCount,
      spikes: spikeCount,
      prefabs: store.project.prefabs.length,
      tiles: painted,
      scripts: GAME_SCRIPTS.length,
      undoDepth: store.stack().depth,
    },
  };
}

// ----------------------------------------------------------------------- CLI

const target = process.argv[2] ?? resolve(process.cwd(), "samples");
const result = buildSampleGame(target);
console.log(`Built ${result.root}`);
console.log(
  `  ${result.files.length} files · ${result.stats.objects} objects · ` +
    `${result.stats.prefabs} prefabs · ${result.stats.tiles} tiles · ` +
    `${result.stats.undoDepth} undoable edits`,
);
writeFileSync(
  join(target, "coin-rush.build.json"),
  JSON.stringify(result, null, 2) + "\n",
);

/** Screenshots are inlined as data: URLs so the guide is one portable file. */
function shot(name: string): string | undefined {
  const abs = join(target, "shots", name);
  if (!existsSync(abs)) return undefined;
  return `data:image/png;base64,${readFileSync(abs).toString("base64")}`;
}

const guide = join(target, "coin-rush-build-guide.html");
writeFileSync(
  guide,
  renderGuide(result, { editor: shot("editor.png"), running: shot("running.png") }),
);
console.log(`Wrote ${guide}`);
