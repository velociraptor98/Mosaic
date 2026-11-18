import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parsePhaserAtlas } from "../../../src/editor/assets/atlasJson";
import { generateProjectFiles } from "../../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../../src/editor/project/scaffold";
import { projectToFiles } from "../../../src/editor/project/serialize";
import { ProjectStore } from "../../../src/editor/store/project";
import { describeTiledMap, tiledFromGrid, tiledToDataUrl } from "../../../src/shared/tiled";
import {
  DEFAULT_CAMERA,
  type AssetDef,
  type BodyDef,
  type ProjectConfig,
  type SceneObject,
} from "../../../src/shared/types";
import {
  BARREL,
  BULLET,
  EXPLOSION,
  LEVEL,
  MAIN,
  PICKUP,
  PLAYER,
  SPAWNER,
  TITLE,
  ZOMBIE,
} from "./code";
import { GROUND, PX, SURVIVOR, TILE_INDEX as T, WALKER, drawArt } from "./art";

/**
 * Builds Holdout: a top-down survival shooter for testing the editor with real
 * art — 16-bit style pixel art in two packed atlases, a tilesheet that is both
 * a Tiled tileset and a spritesheet, plain images, sound effects and music.
 *
 * Every layout step below is a real, undoable transaction on a ProjectStore,
 * the same calls the canvas and the inspector make, and the result is saved
 * the way the editor saves. The game's behaviour is the hand-written code in
 * ./code.ts. If the editor cannot express a step, this file cannot take it.
 */

/**
 * The sound as it arrived: Kenney's effects, a gunshot and a music loop. See
 * ./art/CREDITS.md. From the repo root, which is where `npm run sample` runs:
 * this file is bundled into node_modules/.sample before it runs. The pictures
 * are drawn by ./art.ts.
 */
const ART = resolve("scripts/sample/holdout/art");

const CONFIG: ProjectConfig = {
  ...DEFAULT_OPTIONS.config,
  canvas: { width: 1024, height: 576 },
  tile: 64,
  scale: "FIT",
  physics: "arcade",
  // Pixel art: Phaser keeps it crisp when it is scaled or turned.
  pixelArt: true,
};

const TILE = 64;
const COLS = 40;
const ROWS = 30;

/** Centre of a tile, in pixels. */
const at = (c: number) => c * TILE + TILE / 2;

// --------------------------------------------------------------------- tiles
// Indices into tiles.png (8 × 6 tiles of 64px), the same numbers Tiled shows.

const { GRASS, DIRT, CONCRETE, WOOD, LEAVES, DEBRIS, TREE, BUSH } = T;

/** Same seed, same level: the map is rebuilt byte for byte. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** The level as Tiled would hold it: four tile layers drawn with tiles.png. */
function paintLevel() {
  const random = rng(7);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const grid = (fill = -1) => Array.from({ length: ROWS }, () => Array<number>(COLS).fill(fill));
  const ground = grid();
  const details = grid();
  const walls = grid();
  const canopy = grid();

  // Walls: the compound's perimeter with a gate in each side, a house and a shed.
  const solid = new Set<string>();
  const wall = (c: number, r: number) => solid.add(`${c},${r}`);
  const rect = (c0: number, r0: number, c1: number, r1: number, gaps: [number, number][] = []) => {
    for (let c = c0; c <= c1; c++) for (const r of [r0, r1]) wall(c, r);
    for (let r = r0; r <= r1; r++) for (const c of [c0, c1]) wall(c, r);
    for (const [c, r] of gaps) solid.delete(`${c},${r}`);
  };
  rect(8, 6, 31, 23, [[19, 6], [20, 6], [19, 23], [20, 23], [8, 14], [8, 15], [31, 14], [31, 15]]);
  rect(11, 8, 17, 13, [[14, 13], [17, 10]]);
  rect(23, 16, 28, 21, [[23, 18], [26, 16]]);
  const isWall = (c: number, r: number) => solid.has(`${c},${r}`);

  const inCompound = (c: number, r: number) => c > 8 && c < 31 && r > 6 && r < 23;
  const inHouse = (c: number, r: number) => (c > 11 && c < 17 && r > 8 && r < 13) || (c > 23 && c < 28 && r > 16 && r < 21);
  const onPath = (c: number, r: number) =>
    ((c === 19 || c === 20) && (r <= 6 || r >= 23)) || ((r === 14 || r === 15) && (c <= 8 || c >= 31));

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      ground[r][c] = inHouse(c, r) ? WOOD : inCompound(c, r) ? pick(CONCRETE) : onPath(c, r) ? pick(DIRT) : pick(GRASS);
      if (isWall(c, r)) {
        const mask =
          (isWall(c, r - 1) ? 1 : 0) | (isWall(c + 1, r) ? 2 : 0) | (isWall(c, r + 1) ? 4 : 0) | (isWall(c - 1, r) ? 8 : 0);
        walls[r][c] = T.WALL(mask);
        continue;
      }
      if (onPath(c, r) || inHouse(c, r)) continue;
      const roll = random();
      if (inCompound(c, r) && roll < 0.035) details[r][c] = pick(DEBRIS);
      else if (!inCompound(c, r) && roll < 0.05) details[r][c] = LEAVES;
    }
  }

  // Trees and bushes outside the walls, drawn ABOVE the people: the player
  // walks under them.
  const trees: [number, number][] = [
    [2, 2], [5, 8], [1, 18], [3, 24], [12, 26], [25, 26], [34, 2], [36, 9], [35, 21], [26, 1], [13, 2],
  ];
  for (const [c, r] of trees) {
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) canopy[r + dr][c + dc] = TREE[dr][dc];
  }
  for (const [c, r] of [[6, 4], [33, 25], [4, 20], [37, 15], [16, 27], [29, 4]] as [number, number][]) {
    canopy[r][c] = BUSH;
  }

  const solidTiles = Array.from({ length: 16 }, (_, mask) => T.WALL(mask));
  return {
    layers: [
      { name: "Ground", data: ground },
      { name: "Details", data: details },
      { name: "Walls", data: walls },
      { name: "Canopy", data: canopy },
    ],
    solidTiles,
  };
}

// -------------------------------------------------------------------- assets

/** Width and height from a PNG's header. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function body(patch: Partial<BodyDef>): BodyDef {
  return {
    shape: "box",
    width: 32,
    height: 32,
    radius: 16,
    offsetX: 0,
    offsetY: 0,
    immovable: false,
    allowGravity: false,
    bounce: 0,
    collideWorldBounds: true,
    ...patch,
  };
}

export function buildHoldout(location: string, name = "Holdout") {
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
  const write = (rel: string, contents: string | Buffer, encoding: "utf8" | "base64" = "utf8") => {
    const abs = join(plan.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof contents === "string") writeFileSync(abs, contents, encoding);
    else writeFileSync(abs, contents);
    if (!files.includes(rel)) files.push(rel);
  };
  for (const file of plan.writes) write(file.rel, file.contents, file.encoding);
  log.push(`New project… → Empty template, TypeScript, Vite, 1024 × 576, 64px grid, pixel art on`);

  const store = new ProjectStore();
  store.loadProject(structuredClone(plan.project));

  // ---------------------------------------------------------------- 2. import
  // Import assets… with the art picked as it came: each sheet beside the XML
  // its packer wrote, which is what makes it an atlas with named frames. Keys
  // are what the import dialog derives from the file name.
  const art = drawArt();
  const imported: AssetDef[] = [];
  const copy = (from: string, rel: string) => {
    mkdirSync(dirname(join(plan.root, rel)), { recursive: true });
    copyFileSync(join(ART, from), join(plan.root, rel));
    files.push(rel);
  };
  const image = (file: string, patch: Partial<AssetDef> = {}): AssetDef => {
    const rel = `assets/${file}`;
    const bytes = art[file] as Buffer;
    write(rel, bytes);
    const def: AssetDef = {
      id: `asset-${file.replace(/\W+/g, "_")}`,
      key: file.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_"),
      kind: "image",
      path: rel,
      url: rel,
      ...pngSize(bytes),
      ...patch,
    };
    imported.push(def);
    return def;
  };
  for (const sheet of ["characters", "effects"]) {
    const xml = `${sheet}.xml`;
    write(`assets/${xml}`, art[xml] as string);
    const frames = parsePhaserAtlas(art[xml] as string);
    if (!frames?.length) throw new Error(`${xml} did not read as an atlas`);
    image(`${sheet}.png`, { kind: "atlas", frames });
  }
  // One sheet, two uses: the tileset the Tiled map draws with, and a
  // spritesheet the barrels, crates and hatches are cut from. Corrected from
  // "image" to "spritesheet", 64 × 64, in the import dialog.
  image("tiles.png", { kind: "spritesheet", frameWidth: TILE, frameHeight: TILE, margin: 0, spacing: 0 });
  image("weapon_machine.png");
  image("weapon_silencer.png");
  for (const clip of ["shot", "explosion", "splat", "hit", "pickup", "reload", "music"]) {
    const rel = `assets/audio/${clip}.mp3`;
    copy(`audio/${clip}.mp3`, rel);
    imported.push({ id: `asset-audio-${clip}`, key: `audio_${clip}`, kind: "audio", path: rel, url: rel, width: 0, height: 0 });
  }
  copy("CREDITS.md", "assets/CREDITS.md");
  store.importAssets(imported);
  const characters = imported.find((a) => a.key === "characters")!;
  const effects = imported.find((a) => a.key === "effects")!;
  log.push(
    `Import assets… → characters.png + .xml (${characters.frames!.length} frames), effects.png + .xml (${effects.frames!.length} frames), ` +
      `tiles.png as a 64px spritesheet, two weapon images, seven sounds`,
  );

  // ------------------------------------------------------------------- 3. map
  // Drawn in Tiled against tiles.png: Ground, Details, Walls (whose tiles carry
  // `collides`) and Canopy.
  const painted = paintLevel();
  const tiles = imported.find((a) => a.key === "tiles")!;
  const tmj = tiledFromGrid({
    cols: COLS,
    rows: ROWS,
    tileWidth: TILE,
    tileHeight: TILE,
    layers: painted.layers,
    tileset: {
      name: "tiles",
      image: "../tiles.png",
      imageWidth: tiles.width,
      imageHeight: tiles.height,
      tileWidth: TILE,
      tileHeight: TILE,
      collides: painted.solidTiles,
    },
  });
  const mapPath = "assets/maps/Level_01.tmj";
  store.importAssets([
    {
      id: "asset-map-Level_01",
      key: "Level_01",
      kind: "tilemap",
      path: mapPath,
      url: tiledToDataUrl(tmj),
      width: COLS * TILE,
      height: ROWS * TILE,
      tilemap: describeTiledMap(tmj, mapPath, store.project.assets),
    },
  ]);
  store.hydrateTilemaps();
  log.push(`Tiled → ${mapPath}, ${COLS} × ${ROWS}: Ground, Details, Walls (collides), Canopy — all drawn with tiles.png`);

  // ----------------------------------------------------------------- 4. scene
  const scene = store.scene!;
  store.transact("Scene settings", () => {
    scene.settings.width = COLS * TILE;
    scene.settings.height = ROWS * TILE;
    scene.settings.gravityY = 0;
    scene.settings.gridSize = TILE;
    scene.settings.backgroundColor = GROUND;
    scene.settings.camera = {
      ...DEFAULT_CAMERA,
      follow: "Player",
      lerpX: 0.1,
      lerpY: 0.1,
      deadzoneWidth: 160,
      deadzoneHeight: 100,
      clampToBounds: true,
    };
    scene.settings.music = { key: "audio_music", volume: 0.35, loop: true };
  });
  store.addTilemap("Level_01");
  // The map's layers arrive under the objects. The canopy goes above them, so
  // people walk under the trees; the HUD gets a layer of its own on top.
  const layerNamed = (n: string) => store.scene!.layers.find((l) => l.name === n)!;
  store.moveLayer(layerNamed("Canopy").id, 1);
  store.addLayer("HUD");
  log.push(
    `Scene tab → ${COLS * TILE} × ${ROWS * TILE}, no gravity, music on loop, camera follows Player with a deadzone · ` +
      `Map tab → Add to scene · Layers: Canopy dragged above Objects, + HUD`,
  );

  // ---------------------------------------------------------------- 5. groups
  for (const unused of ["solid", "hazard", "trigger"]) store.removeGroup(unused);
  for (const group of ["enemy", "bullet", "barrel", "cover"]) store.addGroup(group);
  log.push(`Physics tab → Groups: ${store.project.groups.join(", ")}`);

  store.setActiveLayer(layerNamed("Objects").id);

  /** Drag a frame of an atlas or sheet onto the canvas. */
  const sprite = (texture: string, frame: string | undefined, x: number, y: number, extra: Partial<SceneObject> = {}) =>
    store.addObject({ type: "sprite", name: texture, x, y, texture, frame, data: {}, ...extra })!;
  /** Drag a prefab from the asset browser onto the canvas. */
  const place = (prefab: string, x: number, y: number, label?: string) => {
    const def = store.resolvePrefab(prefab)!;
    const id = store.addObject({
      type: def.root.type,
      name: def.name,
      x,
      y,
      prefab,
      overrides: {},
      texture: def.root.texture,
      frame: def.root.frame,
      data: {},
    })!;
    if (label) store.setObjectProp(id, "name", label, "Rename");
    return id;
  };

  // ------------------------------------------------------------- 6. animation
  // Timeline: frames picked from the atlases. The reload holds its middle pose
  // with a per-frame duration; the walks loop; the explosion runs once.
  const frames = (key: string, names: string[], durations: number[] = []) =>
    names.map((frame, i) => ({ textureKey: key, frame, ...(durations[i] ? { duration: durations[i] } : {}) }));
  store.upsertAnim({
    key: "survivor_reload",
    frames: frames("characters", ["survivor_hold", "survivor_reload", "survivor_hold"], [90, 650, 90]),
    fps: 10,
    repeat: 0,
  });
  const walk = (who: string) => [0, 1, 2, 3].map((i) => `${who}_${i}`);
  store.upsertAnim({ key: "zombie_walk", frames: frames("characters", walk("zombie")), fps: 5, repeat: -1 });
  store.upsertAnim({ key: "robot_walk", frames: frames("characters", walk("robot")), fps: 4, repeat: -1 });
  store.upsertAnim({
    key: "explode",
    frames: frames("effects", [0, 1, 2, 3, 4, 5].map((i) => `blast_${i}`)),
    fps: 14,
    repeat: 0,
  });
  log.push(`Animation timeline → survivor_reload (holds 650ms on the middle frame), zombie_walk, robot_walk, explode`);

  // ---------------------------------------------------------------- 7. player
  // The frames have the gun sticking out to the right, so the origin goes on
  // the head — that is what it turns about — and the body is a circle around it.
  const headAt = (who: { width: number; height: number; headX: number }, radius: number) => ({
    originX: who.headX / who.width,
    originY: 0.5,
    body: body({
      shape: "circle",
      radius,
      offsetX: who.headX * PX - radius,
      offsetY: (who.height / 2) * PX - radius,
    }),
  });
  const playerId = sprite("characters", "survivor_pistol", 20 * TILE, 15 * TILE, {
    name: "Player",
    group: "player",
    ...headAt(SURVIVOR, 16),
  });
  store.createPrefab({ name: "Player", objectId: playerId, exposed: [], keepAsInstance: true });
  log.push(`Place characters › survivor_pistol → origin on the head, circle body → Prefab "Player"`);

  // --------------------------------------------------------------- 8. enemies
  const seedZombie = sprite("characters", "zombie_0", at(4), at(4), {
    name: "Zombie",
    group: "enemy",
    playOnSpawn: "zombie_walk",
    ...headAt(WALKER, 16),
  });
  store.createPrefab({ name: "Zombie", objectId: seedZombie, exposed: [], keepAsInstance: true });

  // A robot is a zombie with other art and bigger numbers: a variant. Its
  // frames are the zombie's size, so the head, origin and body line up.
  store.createVariant("Zombie", "Robot");
  store.openPrefab("Robot");
  const robotRoot = store.prefabDoc!.rootId;
  store.setObjectProp(robotRoot, "frame", "robot_0", "Set frame");
  store.setObjectProp(robotRoot, "playOnSpawn", "robot_walk", "Set animation");
  store.setClassProp(robotRoot, "speed", 52);
  store.setClassProp(robotRoot, "health", 8);
  store.setClassProp(robotRoot, "damage", 20);
  store.setClassProp(robotRoot, "points", 40);
  store.planPrefabSave();
  store.pushPrefabSave();
  store.closePrefab();

  place("Zombie", at(35), at(6));
  place("Zombie", at(6), at(25));
  const slowRobot = place("Robot", at(36), at(26));
  // Per instance: this one is slower still.
  store.setClassProp(slowRobot, "speed", 36);
  log.push(
    `Place zombie_0 → circle body, plays zombie_walk → Prefab "Zombie" → variant "Robot" ` +
      `(robot_0, robot_walk, health 8) → place 3 more, one Robot slower`,
  );

  // ------------------------------------------------- 9. made by code, not placed
  // Promoted from something on the canvas, then deleted from it: what is left
  // is the prefab, for the game's code to make with `new`.
  const seedBullet = sprite("effects", "bullet", at(20), at(10), {
    name: "Bullet",
    group: "bullet",
    body: body({ shape: "circle", radius: 4, offsetX: 0, offsetY: 4, collideWorldBounds: false }),
  });
  store.createPrefab({ name: "Bullet", objectId: seedBullet, exposed: [], keepAsInstance: true });
  const seedBlast = sprite("effects", "blast_0", at(20), at(10), {
    name: "Explosion",
    playOnSpawn: "explode",
    sounds: { spawn: "audio_explosion" },
  });
  store.createPrefab({ name: "Explosion", objectId: seedBlast, exposed: [], keepAsInstance: true });
  store.deleteObjects([seedBullet, seedBlast]);
  log.push(
    `Place effects › bullet → Prefab "Bullet"; effects › blast_0, plays explode, ` +
      `on spawn audio_explosion → Prefab "Explosion"; delete both from the scene`,
  );

  // --------------------------------------------------------------- 10. barrels
  const seedBarrel = sprite("tiles", String(T.BARREL), at(17), at(7), {
    name: "Barrel",
    group: "barrel",
    body: body({ shape: "circle", radius: 24, offsetX: 8, offsetY: 8, immovable: true, collideWorldBounds: false }),
  });
  store.createPrefab({ name: "Barrel", objectId: seedBarrel, exposed: [], keepAsInstance: true });
  const barrels: [number, number][] = [[22, 22], [9, 17], [30, 12], [5, 12], [34, 18], [18, 7]];
  for (const [c, r] of barrels) place("Barrel", at(c), at(r));
  // Per instance: the first one, by the north gate, has a shorter fuse.
  store.setClassProp(seedBarrel, "health", 1);
  log.push(`Place tiles › ${T.BARREL} → immovable circle body → Prefab "Barrel" → place ${barrels.length + 1}`);

  // ----------------------------------------------------------------- 11. cover
  // Crates are plain sprites: no class, nothing to do but be in the way.
  const crate = sprite("tiles", String(T.CRATE), 1408, 544, {
    name: "Crate",
    group: "cover",
    body: body({ width: 48, height: 48, offsetX: 8, offsetY: 8, immovable: true, collideWorldBounds: false }),
  });
  store.setSelection([crate]);
  store.fillGrid([crate], { cols: 3, rows: 1, dx: 48, dy: 0 });
  const crate2 = sprite("tiles", String(T.CRATE), 1568, 672, {
    name: "Crate",
    group: "cover",
    body: body({ width: 48, height: 48, offsetX: 8, offsetY: 8, immovable: true, collideWorldBounds: false }),
  });
  store.fillGrid([crate2], { cols: 2, rows: 2, dx: 48, dy: 48 });
  sprite("tiles", String(T.CRATE), at(14), at(18), {
    name: "Crate",
    group: "cover",
    rotation: 20,
    body: body({ width: 48, height: 48, offsetX: 8, offsetY: 8, immovable: true, collideWorldBounds: false }),
  });
  log.push(`Place tiles › ${T.CRATE} → immovable box body, group cover → Fill grid 3 × 1 and 2 × 2 → one more, turned 20°`);

  // -------------------------------------------------------------- 12. spawners
  const seedSpawner = sprite("tiles", String(T.HATCH), 20 * TILE, at(1), { name: "Spawner" });
  store.createPrefab({ name: "Spawner", objectId: seedSpawner, exposed: [], keepAsInstance: true });
  store.setObjectProp(seedSpawner, "name", "SpawnerNorth", "Rename");
  const south = place("Spawner", 20 * TILE, at(28), "SpawnerSouth");
  const west = place("Spawner", at(1), 15 * TILE, "SpawnerWest");
  const east = place("Spawner", at(38), 15 * TILE, "SpawnerEast");
  // Per instance, in the Code tab: how often each lets one out, and what.
  store.setClassProp(seedSpawner, "every", 2600);
  store.setClassProp(south, "every", 3000);
  store.setClassProp(south, "delay", 1500);
  store.setClassProp(west, "every", 3400);
  store.setClassProp(west, "delay", 800);
  store.setClassProp(east, "kind", "Robot");
  store.setClassProp(east, "every", 6500);
  store.setClassProp(east, "delay", 3000);
  log.push(`Place tiles › ${T.HATCH} → Prefab "Spawner" → place 4 at the gates' paths, each with its own kind, rate and delay`);

  // --------------------------------------------------------------- 13. pickups
  const seedPickup = sprite("weapon_machine", undefined, at(14), at(10), {
    name: "Pickup",
    group: "pickup",
    body: body({ width: 64, height: 20, offsetX: 4, offsetY: 4, collideWorldBounds: false }),
  });
  // The texture is published to instances, so each pickup shows its own gun.
  store.createPrefab({ name: "Pickup", objectId: seedPickup, exposed: ["texture"], keepAsInstance: true });
  store.setObjectProp(seedPickup, "name", "MachineGun", "Rename");
  const silencer = place("Pickup", at(25), at(18), "Silencer");
  store.setObjectProp(silencer, "texture", "weapon_silencer", "Set texture");
  store.setClassProp(silencer, "weapon", "silencer");
  log.push(`Place weapon_machine → Prefab "Pickup", texture exposed → place a second, texture weapon_silencer, weapon "silencer"`);

  // ------------------------------------------------------------------- 14. HUD
  store.setActiveLayer(layerNamed("HUD").id);
  const hud = (content: string, x: number, y: number, name: string, patch: (o: SceneObject) => void) => {
    const id = store.addText(content, { x, y })!;
    store.transact(`Style ${name}`, () => {
      const obj = store.scene!.objects.find((o) => o.id === id)!;
      obj.name = name;
      obj.text = { ...obj.text!, color: "#ffffff", stroke: "#14171a", strokeThickness: 5, fontSize: 20, fixed: true };
      patch(obj);
    });
  };
  hud("HP 100    PISTOL 12/12", 16, 12, "Status", (o) => {
    o.originX = 0;
    o.originY = 0;
  });
  hud("WAVE 1    SCORE 0", 1008, 12, "Score", (o) => {
    o.originX = 1;
    o.originY = 0;
    o.text!.align = "right";
  });
  hud("WAVE 1", 512, 200, "Banner", (o) => {
    o.text!.fontSize = 40;
    o.text!.align = "center";
  });
  hud("WASD move · mouse aim · click shoot · R reload", 512, 564, "Hint", (o) => {
    o.originY = 1;
    o.text!.fontSize = 14;
    o.text!.strokeThickness = 3;
    o.text!.color = "#dfe7ee";
  });
  log.push(`Text (T) × 4 on the HUD layer → Status, Score (right-aligned), Banner, Hint — all pinned to the camera`);

  // ----------------------------------------------------------------- 15. title
  // A second scene: the corner of the level's own map, without its debris,
  // under words on a layer of their own so the tree tops cannot cover them.
  store.createScene("Title", "empty");
  const title = store.scene!;
  store.transact("Scene settings", () => {
    title.settings.backgroundColor = "#14171a";
    title.settings.gridSize = TILE;
  });
  store.addTilemap("Level_01");
  store.removeLayer(store.scene!.layers.find((l) => l.name === "Details")!.id);
  store.moveLayer(store.scene!.layers.find((l) => l.name === "Canopy")!.id, 1);
  store.setActiveLayer(store.scene!.layers.find((l) => l.kind === "object")!.id);
  const facing = (who: { width: number; headX: number }) => ({ originX: who.headX / who.width });
  sprite("characters", "survivor_machinegun", 300, 360, { name: "Survivor", ...facing(SURVIVOR), rotation: -15 });
  sprite("characters", "zombie_0", 700, 330, { name: "Walker", ...facing(WALKER), rotation: 190, playOnSpawn: "zombie_walk" });
  sprite("characters", "zombie_2", 790, 400, { name: "Walker", ...facing(WALKER), rotation: 175, playOnSpawn: "zombie_walk" });
  sprite("characters", "robot_0", 860, 290, { name: "Robot", ...facing(WALKER), rotation: 200, playOnSpawn: "robot_walk" });
  sprite("tiles", String(T.BARREL), 220, 430, { name: "Barrel" });
  store.addLayer("Text");
  const words = (content: string, x: number, y: number, name: string, size: number, extra: Partial<SceneObject["text"]> = {}) => {
    const id = store.addText(content, { x, y })!;
    store.transact(`Style ${name}`, () => {
      const obj = store.scene!.objects.find((o) => o.id === id)!;
      obj.name = name;
      obj.text = { ...obj.text!, color: "#ffffff", stroke: "#14171a", strokeThickness: 6, fontSize: size, align: "center", ...extra };
    });
  };
  words("HOLDOUT", 512, 130, "Heading", 76, { strokeThickness: 10 });
  words("Hold the compound. They come in waves.", 512, 200, "Tagline", 22);
  words("click to start", 512, 470, "Prompt", 26);
  words(
    'Sound: Kenney (CC0) · Music: "Zombies March" by yd (CC0) · Gunshot: Kurt (CC0)',
    512,
    556,
    "Credits",
    13,
    { strokeThickness: 3, color: "#dfe7ee" },
  );
  log.push(
    `New scene "Title" (Empty) → Map tab → Add Level_01, remove its Details layer, Canopy above Objects → ` +
      `four atlas sprites and a barrel → + Text layer, four texts`,
  );

  // ------------------------------------------------------------------ 16. code
  // Nothing below is an edit in the editor. These are the files that are
  // "yours": Mosaic wrote a starting point for each and will not open them
  // again, and this is what a developer typed over it. Robot needs no code of
  // its own; its starting point is kept as Mosaic wrote it.
  write("src/main.ts", MAIN);
  write("src/scenes/Title.ts", TITLE);
  write("src/scenes/Level_01.ts", LEVEL);
  write("src/prefabs/Player.ts", PLAYER);
  write("src/prefabs/Bullet.ts", BULLET);
  write("src/prefabs/Zombie.ts", ZOMBIE);
  write("src/prefabs/Barrel.ts", BARREL);
  write("src/prefabs/Explosion.ts", EXPLOSION);
  write("src/prefabs/Spawner.ts", SPAWNER);
  write("src/prefabs/Pickup.ts", PICKUP);

  // ------------------------------------------------------------------ 17. save
  for (const file of projectToFiles(store.project)) write(file.rel, file.contents);
  for (const file of generateProjectFiles(store.project)) {
    if (file.owner === "yours" && files.includes(file.path)) continue;
    write(file.path, file.contents);
  }
  write("README.md", readme(log));

  return {
    root: plan.root,
    files: files.length,
    objects: store.project.scenes.reduce((n, s) => n + s.objects.length, 0),
    prefabs: store.project.prefabs.length,
    edits: store.project.scenes.reduce((n, s) => n + store.stack(s.key).depth, 0),
    issues: store.validate(),
  };
}

function readme(log: string[]): string {
  return `# Holdout

A top-down survival shooter, laid out in Mosaic and written in Phaser. It
exists to test the editor with real art — 16-bit style pixel art, drawn in
code by the sample's builder — so it is small but leans on most of what Mosaic
does: two packed atlases, a tilesheet that is both a Tiled tileset
and a spritesheet, animation, sound, prefabs made only by code, a variant,
per-instance values, groups, two scenes and a camera that follows.

    npm install
    npm run dev

**WASD** to move, the **mouse** to aim, **click** (or hold) to shoot, **R** to
reload. Zombies climb out of the four hatches in waves; robots join from the
second. Shoot the orange barrels when they are close. The house and the shed
each hold a better gun. Clearing a wave gives back some health.

## Who did what

| | Where it is | Whose |
|---|---|---|
| The ground, walls, debris and tree tops | \`assets/maps/Level_01.tmj\`, a Tiled map with four layers | Tiled's |
| Where everything stands, bodies, groups, camera, music, HUD, both scenes | \`src/scenes/*.scene.json\` → \`*.layout.ts\` | Mosaic's |
| Each prefab's art, body, animation, sound and the variant's numbers | \`src/prefabs/*.prefab.json\` → \`*.layout.ts\` | Mosaic's |
| Animations | \`anims.json\` | Mosaic's |
| Moving, aiming, shooting, reloading | \`src/prefabs/Player.ts\` | yours |
| Chasing and biting (Robot inherits it) | \`src/prefabs/Zombie.ts\` | yours |
| Flying and striking | \`src/prefabs/Bullet.ts\` | yours |
| Spawn timing, per hatch | \`src/prefabs/Spawner.ts\` | yours |
| Colliders, waves, barrels going up, score, losing | \`src/scenes/Level_01.ts\` | yours |
| The title screen | \`src/scenes/Title.ts\` | yours |

## The editor's part, step by step

${log.map((line, i) => `${i + 1}. ${line}`).join("\n")}

## What to check when testing the editor

- **Atlas import:** \`characters\` and \`effects\` came in as Starling XML, the
  format sprite packers write. Frames keep their names (\`survivor_pistol\`), and
  the layout loads the JSON Mosaic writes beside each sheet.
- **Pixel art:** every art pixel is ${PX} × ${PX} on screen, and \`pixelArt\` is on,
  so nothing blurs when the camera follows or a sprite turns. Nothing is placed
  scaled, so no pixel is bigger than another.
- **One sheet, two uses:** \`tiles.png\` is the Tiled map's tileset and a 64px
  spritesheet. Barrels are frame ${T.BARREL}, crates ${T.CRATE}, hatches ${T.HATCH}.
- **Draw order:** Canopy is a tile layer above the Objects layer, so the player
  walks under the trees. The HUD is its own object layer, on top of both.
- **Made by code:** \`Bullet\` and \`Explosion\` are never placed. The explosion's
  animation and sound are set on its prefab and run from its constructor, so
  \`new Explosion()\` in the scene's code plays both.
- **Variant:** \`Robot\` changes Zombie's frame, walk animation and four
  numbers. \`new Robot()\` from a spawner gets all of them.
- **Per-instance values:** each Spawner's kind, rate and delay; the slower
  Robot; the north-gate barrel's shorter fuse; the Silencer pickup's texture,
  which the Pickup prefab exposes.
- **Fill grid:** the crate rows by the north gate and the 2 × 2 stack.
- **Second scene:** Title places two layers of Level_01's map and nothing else
  of it, and plays the walk animations on plain atlas sprites.
- **Camera and HUD:** the camera follows with a deadzone and stops at the
  map's edges; the four texts stay put.
`;
}
