import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { generateProjectFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { makeTemplateMap, shapeSize } from "../../src/editor/store/templates";
import { shapeTextureKey } from "../../src/shared/definitions";
import { bodyForSize } from "../../src/shared/size";
import { DEFAULT_CAMERA, type BodyDef, type ProjectConfig } from "../../src/shared/types";
import { BULLET, ENEMY, LEVEL, MAIN, PLAYER, SPAWNER } from "./code";

/**
 * Builds the Twin Stick sample: a top-down arena shooter.
 *
 * Like the other samples it is authored through the editor's own API — every
 * layout step below is a real, undoable transaction on a ProjectStore, the
 * same calls the canvas and the inspector make — and then saved the way the
 * editor saves. The game's behaviour is the hand-written code in ./code.ts.
 *
 * The split is the point of the sample: WHERE things are, what they look
 * like, how big their bodies are and what their numbers are is the editor's;
 * what any of it DOES is ordinary Phaser.
 */

const CONFIG: ProjectConfig = {
  ...DEFAULT_OPTIONS.config,
  canvas: { width: 960, height: 540 },
  tile: 32,
  scale: "FIT",
  physics: "arcade",
  pixelArt: true,
};

/** The arena is bigger than the screen, so the camera has something to do. */
const COLS = 40;
const ROWS = 24;
const TILE = 32;

/** Placeholder tileset indices: sand is floor, wall and stone are solid. */
const SAND = 3;
const STONE = 1;
const WALL = 4;

/** Cover inside the arena: [col, row, width, height] in tiles. */
const PILLARS: [number, number, number, number][] = [
  [8, 6, 2, 2],
  [30, 6, 2, 2],
  [8, 16, 2, 2],
  [30, 16, 2, 2],
  [18, 10, 4, 1],
  [18, 13, 4, 1],
];

/** A round body centred on the art, for things that turn to face a target. */
function round(shape: string, radius: number, patch: Partial<BodyDef> = {}): BodyDef {
  const size = shapeSize(shape);
  return bodyForSize(size, {
    shape: "circle",
    radius,
    offsetX: Math.round(size.width / 2 - radius),
    offsetY: Math.round(size.height / 2 - radius),
    allowGravity: false,
    ...patch,
  });
}

function placed(shape: string, group?: string) {
  return { type: "sprite", texture: shapeTextureKey(shape), group, data: {} };
}

export function buildTwinStick(location: string, name = "Twin Stick") {
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
  log.push(`New project… → Empty template, TypeScript, Vite, 960 × 540 (${plan.writes.length} files)`);

  const store = new ProjectStore();
  store.loadProject(structuredClone(plan.project));
  const scene = store.scene!;

  // ----------------------------------------------------------------- 2. scene
  store.transact("Scene settings", () => {
    scene.settings.width = COLS * TILE;
    scene.settings.height = ROWS * TILE;
    scene.settings.gravityY = 0;
    // The floor's own colour, so the hairline between placeholder tiles does
    // not read as a grid.
    scene.settings.backgroundColor = "#d4d4d7";
    scene.settings.camera = {
      ...DEFAULT_CAMERA,
      follow: "Player",
      lerpX: 0.15,
      lerpY: 0.15,
      clampToBounds: true,
    };
  });
  log.push(`Scene tab → ${COLS * TILE} × ${ROWS * TILE}, no gravity, camera follows Player`);

  // ----------------------------------------------------------------- 3. arena
  // A Tiled map with two layers: a floor nothing collides with, and walls
  // whose tiles carry the "collides" property.
  const floor = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(SAND));
  const walls = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(-1));
  for (let c = 0; c < COLS; c++) {
    walls[0][c] = WALL;
    walls[ROWS - 1][c] = WALL;
  }
  for (let r = 0; r < ROWS; r++) {
    walls[r][0] = WALL;
    walls[r][COLS - 1] = WALL;
  }
  for (const [col, row, w, h] of PILLARS) {
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) walls[r][c] = STONE;
  }
  const map = makeTemplateMap(
    scene.key,
    [
      { name: "Floor", data: floor },
      { name: "Walls", data: walls },
    ],
    { cols: COLS, rows: ROWS, tile: TILE },
  );
  store.importAssets([map]);
  store.hydrateTilemaps();
  store.addTilemap(map.key);
  log.push(`Map tab → Add to scene: ${map.path} (layers Floor, Walls — drawn in Tiled)`);

  // ---------------------------------------------------------------- 4. groups
  for (const unused of ["solid", "pickup", "hazard", "trigger"]) store.removeGroup(unused);
  store.addGroup("enemy");
  store.addGroup("bullet");
  log.push(`Physics tab → Groups: player, enemy, bullet`);

  const objects = scene.layers.find((l) => l.kind === "object")!;
  store.setActiveLayer(objects.id);

  // ---------------------------------------------------------------- 5. player
  const playerId = store.addObject({
    name: "Player",
    x: (COLS * TILE) / 2,
    y: (ROWS * TILE) / 2 + 64,
    ...placed("capsule", "player"),
    body: round("capsule", 13),
  })!;
  store.createPrefab({ name: "Player", objectId: playerId, exposed: [], keepAsInstance: true });
  // Tuned on the definition: the class says speed = 240, the editor says 260.
  store.openPrefab("Player");
  store.setClassProp(store.prefabDoc!.rootId, "speed", 260);
  store.setClassProp(store.prefabDoc!.rootId, "fireRate", 7);
  store.planPrefabSave();
  store.pushPrefabSave();
  store.closePrefab();
  log.push(`Place capsule → Physics: circle body → Prefab: create "Player" → Scripts tab: speed 260, fireRate 7`);

  // --------------------------------------------------------------- 6. enemies
  const seedEnemy = store.addObject({
    name: "Enemy",
    x: 6 * TILE,
    y: 4 * TILE,
    ...placed("triangle", "enemy"),
    body: round("triangle", 13, { collideWorldBounds: false }),
  })!;
  const enemy = store.createPrefab({ name: "Enemy", objectId: seedEnemy, exposed: [], keepAsInstance: true })!;

  // The fast one is a variant: the same class, smaller, with other numbers.
  store.createVariant("Enemy", "Enemy_Fast");
  store.openPrefab("Enemy_Fast");
  const fastRoot = store.prefabDoc!.rootId;
  store.setObjectProp(fastRoot, "scaleX", 0.7, "Set scale");
  store.setObjectProp(fastRoot, "scaleY", 0.7, "Set scale");
  store.setClassProp(fastRoot, "speed", 170);
  store.setClassProp(fastRoot, "hp", 1);
  store.setClassProp(fastRoot, "points", 25);
  store.planPrefabSave();
  store.pushPrefabSave();
  store.closePrefab();

  const startingEnemies: [number, number, string][] = [
    [34 * TILE, 4 * TILE, "Enemy"],
    [6 * TILE, 20 * TILE, "Enemy"],
    [34 * TILE, 20 * TILE, "Enemy_Fast"],
  ];
  for (const [x, y, prefab] of startingEnemies) {
    store.addObject({
      type: enemy.root!.type,
      name: prefab,
      x,
      y,
      prefab,
      overrides: {},
      texture: enemy.root!.texture,
      data: {},
    });
  }
  log.push(`Place triangle → Prefab "Enemy" → variant "Enemy_Fast" (0.7 scale, speed 170, hp 1, 25 points) → place 4`);

  // ---------------------------------------------------------------- 7. bullet
  // Built on the canvas like anything else, promoted, and then removed from
  // the scene: a bullet is a prefab so that it can be authored, not placed.
  const seedBullet = store.addObject({
    name: "Bullet",
    x: 200,
    y: 200,
    scaleX: 0.5,
    scaleY: 0.5,
    ...placed("star", "bullet"),
    body: round("star", 9, { collideWorldBounds: false }),
  })!;
  store.createPrefab({ name: "Bullet", objectId: seedBullet, exposed: [], keepAsInstance: true });
  store.deleteObjects([seedBullet]);
  store.openPrefab("Bullet");
  store.setClassProp(store.prefabDoc!.rootId, "speed", 620);
  store.setClassProp(store.prefabDoc!.rootId, "lifetime", 800);
  store.planPrefabSave();
  store.pushPrefabSave();
  store.closePrefab();
  log.push(`Place star at 0.5 scale → Prefab "Bullet" → delete it from the scene → Scripts tab: speed 620, lifetime 800`);

  // -------------------------------------------------------------- 8. spawners
  const seedSpawner = store.addObject({
    name: "Spawner",
    x: 3 * TILE,
    y: 3 * TILE,
    ...placed("diamond"),
  })!;
  const spawner = store.createPrefab({ name: "Spawner", objectId: seedSpawner, exposed: [], keepAsInstance: true })!;
  const spawners: [number, number, number, number, string][] = [
    // x, y, interval, delay, kind — the seed is the first row
    [3 * TILE, 3 * TILE, 5, 3, "Enemy"],
    [37 * TILE, 3 * TILE, 6, 6, "Enemy"],
    [3 * TILE, 21 * TILE, 7, 9, "Enemy_Fast"],
    [37 * TILE, 21 * TILE, 8, 12, "Enemy_Fast"],
  ];
  spawners.forEach(([x, y, interval, delay, kind], i) => {
    const id =
      i === 0
        ? seedSpawner
        : store.addObject({
            type: spawner.root!.type,
            name: `Spawner ${i + 1}`,
            x,
            y,
            prefab: "Spawner",
            overrides: {},
            texture: spawner.root!.texture,
            data: {},
          })!;
    // Per instance: these four numbers and four names are the difficulty curve.
    store.setClassProp(id, "interval", interval);
    store.setClassProp(id, "delay", delay);
    store.setClassProp(id, "kind", kind);
  });
  log.push(`Place diamond → Prefab "Spawner" → place one per corner → Scripts tab on each: interval, delay, kind`);

  // -------------------------------------------------------------------- 9. HUD
  const hudId = store.addText("SCORE 0    HP 3", { x: 16, y: 12 })!;
  const bannerId = store.addText("GAME OVER\nclick to play again", { x: 480, y: 250 })!;
  store.transact("Style HUD", () => {
    const hud = store.scene!.objects.find((o) => o.id === hudId)!;
    hud.name = "HUD";
    hud.originX = 0;
    hud.originY = 0;
    hud.text = { ...hud.text!, fontSize: 18, color: "#1d2d3d", fixed: true };
    const banner = store.scene!.objects.find((o) => o.id === bannerId)!;
    banner.name = "Banner";
    banner.text = { ...banner.text!, fontSize: 28, color: "#1d2d3d", align: "center", fixed: true };
  });
  log.push(`Text (T) twice → HUD and Banner, both pinned to the camera`);

  // ------------------------------------------------------------------ 10. code
  // Nothing below is an edit in the editor. These are the files that are
  // "yours": Mosaic wrote a starting point for each and will not open them
  // again, and this is what a developer typed over it.
  write("src/main.ts", MAIN);
  write("src/scenes/Level_01.ts", LEVEL);
  write("src/prefabs/Player.ts", PLAYER);
  write("src/prefabs/Enemy.ts", ENEMY);
  write("src/prefabs/Bullet.ts", BULLET);
  write("src/prefabs/Spawner.ts", SPAWNER);

  // ------------------------------------------------------------------ 11. save
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
    log,
  };
}

function readme(log: string[]): string {
  return `# Twin Stick

A small top-down arena shooter, laid out in Mosaic and written in Phaser.

    npm install
    npm run dev

**Keyboard and mouse:** WASD to move, aim with the mouse, hold the button to
fire. **Gamepad:** left stick moves, right stick aims and fires. Enemies walk
at you; touching one costs a hit point. Click to play again.

Rebuild it from the repo root with \`npm run twin-stick\`, which drives the
editor's own API and then writes the code below over the starting points.

## Who did what

| | Where it is | Whose |
|---|---|---|
| The arena | \`assets/maps/Level_01.tmj\` — a Tiled map, two layers | Tiled's |
| Where everything stands, body sizes, camera, HUD text | \`src/scenes/Level_01.scene.json\` → \`Level_01.layout.ts\` | Mosaic's |
| Each prefab's art, body and tuned numbers | \`src/prefabs/*.prefab.json\` → \`*.layout.ts\` | Mosaic's |
| Moving, aiming, firing | \`src/prefabs/Player.ts\` | yours |
| Chasing, taking hits | \`src/prefabs/Enemy.ts\` (Enemy_Fast inherits it) | yours |
| Flying, expiring | \`src/prefabs/Bullet.ts\` | yours |
| Asking for enemies on a timer | \`src/prefabs/Spawner.ts\` | yours |
| What collides with what, score, game over | \`src/scenes/Level_01.ts\` | yours |

## The editor's part, step by step

${log.map((line, i) => `${i + 1}. ${line}`).join("\n")}

## Things worth looking at

- **A prefab that is never placed.** No bullet is in the scene. \`Bullet\` is a
  prefab so its art, body and numbers can be authored, and the game makes one
  with \`Bullet.spawn(scene, x, y)\` — \`new\`, plus the values set on the
  definition in the editor.
- **A variant is the same class.** \`Enemy_Fast\` has no behaviour of its own;
  it extends \`Enemy\` and differs by scale and three numbers.
- **The difficulty curve is four inspector rows.** Each spawner's interval,
  delay and kind are \`@property\` fields set per instance.
- **Collisions are six lines** in \`Level_01.ts\`, written against the groups and
  the tile layer the layout hands back.

## What building it turned up

This sample was the first game made with the editor after it became a layout
tool, and it was built to find out where that falls short. Three things did,
and were fixed in the editor rather than worked around here:

- **A prefab nobody placed had no texture.** The layout only loaded art for
  objects in the scene, so a bullet spawned from code arrived invisible. Every
  prefab's art is loaded now.
- **Numbers set on a definition did not reach spawned objects.** They were only
  assigned to instances the layout itself built. Prefab classes now carry the
  definition's values and a \`spawn()\` that applies them.
- **"HUD" became \`layout.hUD\`.** Names that start with an acronym are
  camel-cased properly now.
- **A group only existed if something placed was in it**, so the bullets' group
  had to be made in code. The layout now hands back every group the project
  defines.
- **A spawned object lost its body settings and drew below the walls.** Adding
  it to an arcade group reset them (gravity came back on), and nothing gave it
  a depth. A layout group now restores
  the authored body, and gives an object with no depth the depth of the layer
  the group's objects were placed on.

And things that are still rough, left as they are:

- The spawners' \`kind\` is a string the scene maps to a class. There is no way
  to point a field at a prefab.
- The art is the editor's placeholder shapes. Nothing here depends on them.
`;
}

// ----------------------------------------------------------------------- CLI

const target = process.argv[2] ?? resolve(process.cwd(), "samples");
const result = buildTwinStick(target);
console.log(`Built ${result.root}`);
console.log(
  `  ${result.files} files · ${result.objects} objects · ${result.prefabs} prefabs · ${result.edits} undoable edits`,
);
