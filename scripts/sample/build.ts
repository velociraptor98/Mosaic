import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { generateProjectFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { makeTemplateMap, shapeSize } from "../../src/editor/store/templates";
import { shapeTextureKey } from "../../src/shared/definitions";
import { bodyForSize } from "../../src/shared/size";
import { DEFAULT_CAMERA, type BodyDef, type ProjectConfig, type SceneObject } from "../../src/shared/types";
import { COIN, LEVEL, MAIN, MOVING_PLATFORM, PLAYER } from "./code";

/**
 * Builds Coin Run: a short side-scrolling platformer for testing the editor.
 *
 * Every layout step below is a real, undoable transaction on a ProjectStore,
 * the same calls the canvas and the inspector make, and the result is saved
 * the way the editor saves. The game's behaviour is the hand-written code in
 * ./code.ts. If the editor cannot express a step, this file cannot take it.
 */

const CONFIG: ProjectConfig = {
  ...DEFAULT_OPTIONS.config,
  canvas: { width: 960, height: 544 },
  tile: 32,
  scale: "FIT",
  physics: "arcade",
  pixelArt: true,
};

const TILE = 32;
const COLS = 60;
const ROWS = 17;
/** The top of the ground, in pixels: rows 15 and 16 are solid. */
const GROUND_Y = 15 * TILE;

/** Placeholder tileset indices. Stone and Brick carry `collides`; Water does not. */
const STONE = 1;
const WATER = 2;
const BRICK = 5;

/** Gaps in the ground: [first column, last column]. */
const PITS: [number, number][] = [
  [18, 20],
  [37, 42],
];
/** Floating ledges: [first column, last column, row]. */
const LEDGES: [number, number, number][] = [
  [9, 12, 12],
  [23, 26, 12],
  [29, 31, 9],
];

/** Centre x of a tile column. */
const col = (c: number) => c * TILE + TILE / 2;

function placed(shape: string, group?: string): Partial<SceneObject> & { type: string } {
  return { type: "sprite", texture: shapeTextureKey(shape), group, data: {} };
}

function body(shape: string, patch: Partial<BodyDef>): BodyDef {
  return bodyForSize(shapeSize(shape), patch);
}

export function buildCoinRun(location: string, name = "Coin Run") {
  const log: string[] = [];

  // ---------------------------------------------------------------- 1. folder
  const plan = planScaffold({
    ...DEFAULT_OPTIONS,
    name,
    location,
    template: "empty",
    language: "ts",
    bundler: "vite",
    git: false,
    sampleArt: false,
    config: CONFIG,
  });
  const files: string[] = [];
  const write = (rel: string, contents: string, encoding: "utf8" | "base64" = "utf8") => {
    const abs = join(plan.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, encoding);
    if (!files.includes(rel)) files.push(rel);
  };
  for (const file of plan.writes) write(file.rel, file.contents, file.encoding);
  log.push(`New project… → Empty template, TypeScript, Vite, 960 × 544`);

  const store = new ProjectStore();
  store.loadProject(structuredClone(plan.project));
  const scene = store.scene!;

  // ----------------------------------------------------------------- 2. scene
  store.transact("Scene settings", () => {
    scene.settings.width = COLS * TILE;
    scene.settings.height = ROWS * TILE;
    scene.settings.gravityY = 900;
    scene.settings.backgroundColor = "#dfe7ee";
    // The bottom edge is open, so falling into a pit leaves the world.
    scene.settings.bounds = { left: true, right: true, top: true, bottom: false };
    scene.settings.camera = {
      ...DEFAULT_CAMERA,
      follow: "Player",
      lerpX: 0.12,
      lerpY: 0.12,
      clampToBounds: true,
    };
  });
  log.push(`Scene tab → ${COLS * TILE} × ${ROWS * TILE}, gravity 900, bottom edge open, camera follows Player`);

  // ------------------------------------------------------------------- 3. map
  // Two layers: water drawn in the pits, which nothing collides with, and the
  // ground and ledges, whose tiles carry the "collides" property.
  const back = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(-1));
  const ground = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(-1));
  for (let c = 0; c < COLS; c++) {
    const inPit = PITS.some(([a, b]) => c >= a && c <= b);
    for (const r of [15, 16]) {
      if (inPit) back[r][c] = WATER;
      else ground[r][c] = STONE;
    }
  }
  for (const [a, b, r] of LEDGES) for (let c = a; c <= b; c++) ground[r][c] = BRICK;
  const map = makeTemplateMap(
    scene.key,
    [
      { name: "Back", data: back },
      { name: "Ground", data: ground },
    ],
    { cols: COLS, rows: ROWS, tile: TILE },
  );
  store.importAssets([map]);
  store.hydrateTilemaps();
  store.addTilemap(map.key);
  log.push(`Map tab → Add to scene: ${map.path} (layers Back, Ground — drawn in Tiled)`);

  // ---------------------------------------------------------------- 4. groups
  for (const unused of ["solid", "trigger"]) store.removeGroup(unused);
  store.addGroup("platform");
  log.push(`Physics tab → Groups: player, pickup, hazard, platform`);

  const objects = scene.layers.find((l) => l.kind === "object")!;
  store.setActiveLayer(objects.id);

  // ---------------------------------------------------------------- 5. player
  const playerId = store.addObject({
    name: "Player",
    x: col(3),
    y: GROUND_Y - 20,
    ...placed("capsule", "player"),
    body: body("capsule", { width: 24, height: 38, offsetX: 2, offsetY: 2 }),
  })!;
  store.createPrefab({ name: "Player", objectId: playerId, exposed: [], keepAsInstance: true });
  // Per instance: the class says lives = 3, this level gives five.
  store.setClassProp(playerId, "lives", 5);
  log.push(`Place capsule → Physics: box body → Prefab "Player" → Code tab on the placed one: lives 5`);

  // ----------------------------------------------------------------- 6. coins
  const coinBody = body("circle", {
    shape: "circle",
    radius: 16,
    allowGravity: false,
    collideWorldBounds: false,
  });
  const seedCoin = store.addObject({
    name: "Coin",
    x: col(6),
    y: GROUND_Y - 40,
    scaleX: 0.6,
    scaleY: 0.6,
    ...placed("circle", "pickup"),
    body: coinBody,
  })!;
  const coin = store.createPrefab({ name: "Coin", objectId: seedCoin, exposed: [], keepAsInstance: true })!;

  // The big one is a variant: the same class, bigger, worth more.
  store.createVariant("Coin", "Coin_Big");
  store.openPrefab("Coin_Big");
  const bigRoot = store.prefabDoc!.rootId;
  store.setObjectProp(bigRoot, "scaleX", 1, "Set scale");
  store.setObjectProp(bigRoot, "scaleY", 1, "Set scale");
  store.setClassProp(bigRoot, "points", 50);
  store.planPrefabSave();
  store.pushPrefabSave();
  store.closePrefab();

  const coins: [number, number, string][] = [
    // x, y, prefab: the seed is the first one
    [col(7), GROUND_Y - 40, "Coin"],
    [col(8), GROUND_Y - 40, "Coin"],
    [col(10), 12 * TILE - 32, "Coin"],
    [col(11), 12 * TILE - 32, "Coin"],
    [col(19), GROUND_Y - 96, "Coin"],
    [col(24), 12 * TILE - 32, "Coin"],
    [col(25), 12 * TILE - 32, "Coin"],
    [col(30), 9 * TILE - 40, "Coin_Big"],
    [col(45), GROUND_Y - 40, "Coin"],
    [col(46), GROUND_Y - 40, "Coin"],
    [col(47), GROUND_Y - 40, "Coin"],
    [col(54), GROUND_Y - 48, "Coin_Big"],
  ];
  for (const [x, y, prefab] of coins) {
    store.addObject({ type: coin.root!.type, name: prefab, x, y, prefab, overrides: {}, texture: coin.root!.texture, data: {} });
  }
  log.push(`Place circle at 0.6 → circle body, no gravity → Prefab "Coin" → variant "Coin_Big" (scale 1, points 50) → place ${coins.length + 1}`);

  // ---------------------------------------------------------------- 7. spikes
  const seedSpike = store.addObject({
    name: "Spike",
    x: col(14),
    y: GROUND_Y - 18,
    ...placed("triangle", "hazard"),
    body: body("triangle", {
      width: 20,
      height: 18,
      offsetX: 4,
      offsetY: 18,
      immovable: true,
      allowGravity: false,
      collideWorldBounds: false,
    }),
  })!;
  const spike = store.createPrefab({ name: "Spike", objectId: seedSpike, exposed: [], keepAsInstance: true })!;
  for (const c of [32, 33, 51]) {
    store.addObject({ type: spike.root!.type, name: "Spike", x: col(c), y: GROUND_Y - 18, prefab: "Spike", overrides: {}, texture: spike.root!.texture, data: {} });
  }
  log.push(`Place triangle → small box body at its base, immovable → Prefab "Spike" → place 4`);

  // ------------------------------------------------------------- 8. platforms
  const platformBody = body("box", { immovable: true, allowGravity: false, collideWorldBounds: false });
  const seedPlatform = store.addObject({
    name: "Platform",
    x: col(39) + TILE / 2,
    y: 13 * TILE + 8,
    scaleX: 3,
    scaleY: 0.5,
    ...placed("box", "platform"),
    body: platformBody,
  })!;
  const platform = store.createPrefab({ name: "MovingPlatform", objectId: seedPlatform, exposed: [], keepAsInstance: true })!;
  const highPlatform = store.addObject({
    type: platform.root!.type,
    name: "Platform High",
    x: col(33),
    y: 11 * TILE,
    prefab: "MovingPlatform",
    overrides: {},
    texture: platform.root!.texture,
    data: {},
  })!;
  // Per instance: one slow and short over the pit, one quicker and wider.
  store.setClassProp(seedPlatform, "range", 48);
  store.setClassProp(seedPlatform, "speed", 50);
  store.setClassProp(highPlatform, "range", 80);
  store.setClassProp(highPlatform, "speed", 90);
  log.push(`Place box at 3 × 0.5 → immovable body → Prefab "MovingPlatform" → place 2, each with its own range and speed`);

  // ------------------------------------------------------------------ 9. goal
  store.addObject({
    name: "Goal",
    x: col(57),
    y: GROUND_Y - 18,
    scaleX: 1.5,
    scaleY: 1.5,
    ...placed("star"),
    body: body("star", { immovable: true, allowGravity: false, collideWorldBounds: false }),
  });
  log.push(`Place star at 1.5 → body → name it Goal (a plain sprite: no class needed)`);

  // ------------------------------------------------------------------- 10. HUD
  const hudId = store.addText("SCORE 0", { x: 16, y: 12 })!;
  const bannerId = store.addText("", { x: 480, y: 240 })!;
  store.transact("Style HUD", () => {
    const hud = store.scene!.objects.find((o) => o.id === hudId)!;
    hud.name = "HUD";
    hud.originX = 0;
    hud.originY = 0;
    hud.text = { ...hud.text!, fontSize: 18, color: "#1d2d3d", fixed: true };
    const banner = store.scene!.objects.find((o) => o.id === bannerId)!;
    banner.name = "Banner";
    banner.originX = 0.5;
    banner.originY = 0.5;
    banner.text = { ...banner.text!, content: "YOU WIN", fontSize: 32, color: "#1d2d3d", align: "center", fixed: true };
  });
  log.push(`Text (T) twice → HUD and Banner, both pinned to the camera`);

  // ------------------------------------------------------------------ 11. code
  // Nothing below is an edit in the editor. These are the files that are
  // "yours": Mosaic wrote a starting point for each and will not open them
  // again, and this is what a developer typed over it. Spike, Coin_Big and
  // the goal need no code of their own.
  write("src/main.ts", MAIN);
  write("src/scenes/Level_01.ts", LEVEL);
  write("src/prefabs/Player.ts", PLAYER);
  write("src/prefabs/Coin.ts", COIN);
  write("src/prefabs/MovingPlatform.ts", MOVING_PLATFORM);

  // ------------------------------------------------------------------ 12. save
  for (const file of projectToFiles(store.project)) write(file.rel, file.contents);
  for (const file of generateProjectFiles(store.project)) {
    if (file.owner === "yours" && files.includes(file.path)) continue;
    write(file.path, file.contents);
  }
  write("README.md", readme(log));

  return {
    root: plan.root,
    files: files.length,
    objects: store.scene!.objects.length,
    prefabs: store.project.prefabs.length,
    edits: store.stack().depth,
  };
}

function readme(log: string[]): string {
  return `# Coin Run

A short side-scrolling platformer, laid out in Mosaic and written in Phaser.
It exists to test the editor, so it is small but touches most of what Mosaic
does.

    npm install
    npm run dev

**Arrow keys** to run, **up** or **space** to jump. Collect the coins, avoid the
spikes and the water, and reach the star. A big coin bursts into three small
ones. Five lives; click to play again.

## Who did what

| | Where it is | Whose |
|---|---|---|
| The ground, ledges and water | \`assets/maps/Level_01.tmj\`, a Tiled map with two layers | Tiled's |
| Where everything stands, bodies, groups, camera, world edges, HUD | \`src/scenes/Level_01.scene.json\` → \`Level_01.layout.ts\` | Mosaic's |
| Each prefab's art, body and the variant's numbers | \`src/prefabs/*.prefab.json\` → \`*.layout.ts\` | Mosaic's |
| Running and jumping | \`src/prefabs/Player.ts\` | yours |
| Bobbing, being collected | \`src/prefabs/Coin.ts\` (Coin_Big inherits it) | yours |
| Sliding back and forth | \`src/prefabs/MovingPlatform.ts\` | yours |
| Collisions, score, lives, winning and losing | \`src/scenes/Level_01.ts\` | yours |

## The editor's part, step by step

${log.map((line, i) => `${i + 1}. ${line}`).join("\n")}

## What to check when testing the editor

- **Tiled map:** two layers. Water is drawn but not solid; Stone and Brick tiles
  carry \`collides\`, and the player stands on them.
- **World edges:** the bottom edge is open. Fall in a pit and you lose a life.
- **Prefab variant:** \`Coin_Big\` is worth 50 and drawn at scale 1, from field
  initialisers in its generated base class. \`new Coin_Big()\` gets them.
- **Per-instance values:** the placed Player has \`lives = 5\` (the class says 3),
  and the two moving platforms have different ranges and speeds.
- **Group config:** the pickup group is created with \`allowGravity: false\`. The
  bonus coins a big coin bursts into are made with \`new Coin()\` and added to
  that group, and they float rather than fall.
- **Immovable bodies:** the moving platforms carry the player.
- **Camera:** follows the player and stops at the level's edges.
- **Text:** the HUD and the banner stay put while the level scrolls.
`;
}
