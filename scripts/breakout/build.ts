import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { generateFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { shapeTextureKey } from "../../src/shared/definitions";
import { scriptFilePath } from "../../src/shared/scripts";
import { bodyForSize } from "../../src/shared/size";
import { DEFAULT_PATHS, type AssetDef, type ProjectConfig } from "../../src/shared/types";
import { GAME_SCRIPTS } from "./scripts";

/**
 * Breakout, rebuilt as a Mosaic project.
 *
 * The original is `public/src/games/breakout/breakout.js` in the Phaser
 * examples repo: one file, one class, everything — the wall, the ball, the
 * paddle, the rules — written inside `create()` and `update()`. This builds the
 * same game the way Mosaic asks you to build one, and it exists to answer a
 * question rather than to be a game: can a whole, real, already-written Phaser
 * game be expressed in this editor's model, and does what comes out the far end
 * actually run?
 *
 * So every byte here comes out of the editor's own code — `planScaffold` plans
 * the folder, `ProjectStore` performs each edit as a real undoable transaction,
 * `projectToFiles` and `generateFiles` write the result. There is no
 * script-only path into the project format: if the editor cannot express
 * something, neither can this, and the places where that bit are recorded in
 * the step log rather than worked around.
 */

export interface BuildStep {
  n: string;
  title: string;
  /** What was done, and why it is done that way. */
  body: string;
  /** The editor action, as a reader would perform it. */
  editor?: string;
  /** The store call the editor makes underneath. */
  api?: string;
  /**
   * Set when this step could not be authored the way the original writes it,
   * and had to be expressed some other way. These are the findings.
   */
  friction?: string;
}

export interface BuildResult {
  root: string;
  steps: BuildStep[];
  files: { rel: string; bytes: number }[];
  stats: {
    objects: number;
    bricks: number;
    prefabs: number;
    variants: number;
    scripts: number;
    assets: number;
    undoDepth: number;
  };
}

/** The original's canvas, exactly: 800 × 600, arcade physics, no gravity. */
const CONFIG: ProjectConfig = {
  paths: DEFAULT_PATHS,
  canvas: { width: 800, height: 600 },
  tile: 32,
  scale: "FIT",
  physics: "arcade",
  // The breakout art is drawn at 1:1 and is not pixel art; nearest-neighbour
  // filtering would only make its anti-aliased edges crunchy.
  pixelArt: false,
};

/** Where the Phaser examples checkout lives. Only its art is read. */
const EXAMPLES = process.env.PHASER_EXAMPLES ?? join(homedir(), "Downloads", "examples-master");
const ART = join(EXAMPLES, "public", "assets", "games", "breakout");

/** The art the game needs, and what size each piece is. */
const ART_FILES: { file: string; width: number; height: number }[] = [
  { file: "ball1.png", width: 22, height: 22 },
  { file: "paddle1.png", width: 104, height: 24 },
  { file: "blue1.png", width: 64, height: 32 },
  { file: "red1.png", width: 64, height: 32 },
  { file: "green1.png", width: 64, height: 32 },
  { file: "yellow1.png", width: 64, height: 32 },
  { file: "silver1.png", width: 64, height: 32 },
  { file: "purple1.png", width: 64, height: 32 },
];

/**
 * The wall, top row first — the same six colours in the same order as the
 * original's `frame: [ 'blue1', 'red1', ... ]`, with a score attached to each
 * because the original keeps none.
 */
const ROWS: { variant: string | null; texture: string; points: number }[] = [
  { variant: null, texture: "blue1", points: 60 },
  { variant: "Brick_Red", texture: "red1", points: 50 },
  { variant: "Brick_Green", texture: "green1", points: 40 },
  { variant: "Brick_Yellow", texture: "yellow1", points: 30 },
  { variant: "Brick_Silver", texture: "silver1", points: 20 },
  { variant: "Brick_Purple", texture: "purple1", points: 10 },
];

/** The original's `gridAlign`, as plain arithmetic: 10 × 6 cells of 64 × 32. */
const COLS = 10;
const CELL_W = 64;
const CELL_H = 32;
const GRID_X = 112;
const GRID_Y = 100;

const brickX = (col: number) => GRID_X + col * CELL_W;
const brickY = (row: number) => GRID_Y + row * CELL_H;

export function buildBreakout(location: string, name = "Breakout"): BuildResult {
  const steps: BuildStep[] = [];
  const step = (s: BuildStep) => steps.push(s);

  if (!existsSync(ART)) {
    throw new Error(
      `Cannot find the Phaser examples art at ${ART}.\n` +
        `Clone https://github.com/phaserjs/examples and point PHASER_EXAMPLES at it.`,
    );
  }

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
      `New project… plans the folder before it writes a byte of it: ${plan.writes.length} files. The EMPTY ` +
      `template is the right start — breakout has no player, no gravity and no terrain, and every ` +
      `other template ships at least one of the three.\n\n` +
      `The canvas is ${CONFIG.canvas.width} × ${CONFIG.canvas.height}, the original's exactly, and pixelArt is off: this ` +
      `art is drawn at 1:1 with soft edges and nearest-neighbour filtering would only make it crunchy.`,
    editor: `New project… → name "${name}", template Empty, TypeScript, Vite, 800 × 600`,
    api: `planScaffold({ name: "${name}", template: "empty", config: { canvas: { width: 800, height: 600 } } })`,
  });

  const files: { rel: string; bytes: number }[] = [];
  const write = (rel: string, contents: string, encoding: "utf8" | "base64" = "utf8") => {
    const abs = join(plan.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, encoding);
    files.push({ rel, bytes: Buffer.from(contents, encoding).byteLength });
  };
  for (const file of plan.writes) write(file.rel, file.contents, file.encoding);

  // From here on every change is a real transaction on a real undo stack,
  // exactly as if it had been clicked.
  const store = new ProjectStore(plan.project);
  const scene = store.scene!;

  // ------------------------------------------------------------- 2. settings
  store.transact("Scene settings", () => {
    scene.settings.gravityY = 0;
    scene.settings.backgroundColor = "#12141c";
  });
  step({
    n: "2",
    title: "Set the court up",
    body:
      `No gravity: in breakout the ball is not falling, it is travelling. The background is scene ` +
      `data like everything else, so the exported game reads the colour from the same field the ` +
      `editor writes.`,
    editor: "Inspector → Scene → Gravity Y = 0, Background #12141c",
    api: `scene.settings.gravityY = 0`,
  });

  // ---------------------------------------------------------------- 3. art
  const assets: AssetDef[] = ART_FILES.map(({ file, width, height }) => {
    const bytes = readFileSync(join(ART, file));
    const rel = `assets/${file}`;
    write(rel, bytes.toString("base64"), "base64");
    const key = file.replace(/\.png$/, "");
    return {
      id: `asset-${key}`,
      key,
      kind: "image",
      path: rel,
      url: `data:image/png;base64,${bytes.toString("base64")}`,
      width,
      height,
    };
  });
  store.importAssets(assets);

  step({
    n: "3",
    title: "Import the art",
    body:
      `Eight PNGs, copied into assets/ the way every import is — Mosaic never references art in ` +
      `place. One ball, one paddle, six brick colours.\n\n` +
      `The original loads all eight out of a packed ATLAS instead, with one \`load.atlas\` call. ` +
      `Mosaic can hold an atlas and does export one, but it can only make an atlas by slicing an ` +
      `image it already has — by grid, or by flood-filling islands of opaque pixels — and it names ` +
      `the frames it finds from a pattern (\`frame_0\`, \`frame_1\`, …). There is no way to bring in ` +
      `the atlas JSON that shipped with the art, so the frame names in it are lost. Eight separate ` +
      `images say the same thing and keep the names, so that is what this uses.`,
    editor: "Assets dock → Import… → the eight PNGs",
    api: `store.importAssets(assets)`,
    friction:
      `An existing Phaser atlas (.png + .json) cannot be imported as one. The slicer builds frames ` +
      `from pixels and names them from a pattern, so re-using packed art means either losing its ` +
      `frame names or unpacking it first.`,
  });

  // -------------------------------------------------------------- 4. groups
  for (const stale of ["player", "solid", "pickup", "hazard", "trigger"]) {
    store.removeGroup(stale);
  }
  for (const group of ["ball", "paddle", "brick"]) store.addGroup(group);

  step({
    n: "4",
    title: "Name the collision groups this game actually has",
    body:
      `The default five — player, solid, pickup, hazard, trigger — are a platformer's vocabulary ` +
      `and none of them fits. They are removed and replaced with ball, paddle and brick.\n\n` +
      `Groups are project data, so this is done once and every scene added later starts with the ` +
      `same three.`,
    editor: "Inspector → Physics → Groups → remove the five, add ball / paddle / brick",
    api: `store.removeGroup("player")\nstore.addGroup("ball")`,
  });

  const objectLayer = scene.layers.find((l) => l.kind === "object")!;
  store.setActiveLayer(objectLayer.id);

  // ------------------------------------------------------------ 5. director
  // FIRST in the scene, deliberately. Scripts start in the order their objects
  // were added, so the director's create() registers its listeners before any
  // brick announces itself.
  const directorId = store.addObject({
    type: "spawn",
    name: "Director",
    x: 400,
    y: 300,
    texture: shapeTextureKey("diamond"),
    data: {},
  })!;
  store.attachScript([directorId], {
    name: "BreakoutDirector",
    src: scriptFilePath("BreakoutDirector"),
  });
  store.setScriptProp(directorId, 0, "lives", 3);
  store.setScriptProp(directorId, 0, "clearBonus", 500);
  store.setScriptProp(directorId, 0, "rebuildWall", true);

  step({
    n: "5",
    title: "Give the round an owner",
    body:
      `A marker object carrying BreakoutDirector, which hides itself at runtime — the same ` +
      `arrangement Coin Rush uses. The original has no such object because it has no such concept: ` +
      `the rules live in the scene class, mixed in with the wall and the ball.\n\n` +
      `It is added FIRST on purpose. Scripts start in the order their objects were added, so the ` +
      `director is listening before any brick announces itself.`,
    editor: "Place tool (B) → a marker at the centre · Scripts tab → + BreakoutDirector",
    api: `store.attachScript([directorId], { name: "BreakoutDirector", src: "src/scripts/BreakoutDirector.ts" })`,
  });

  // -------------------------------------------------------- 6. paddle + ball
  const paddleId = store.addObject({
    type: "sprite",
    name: "Paddle",
    x: 400,
    y: 550,
    texture: "paddle1",
    group: "paddle",
    body: bodyForSize(
      { width: 104, height: 24 },
      { immovable: true, allowGravity: false, collideWorldBounds: false },
    ),
    data: {},
  })!;
  store.attachScript([paddleId], {
    name: "PaddleController",
    src: scriptFilePath("PaddleController"),
  });

  const ballId = store.addObject({
    type: "sprite",
    name: "Ball",
    x: 400,
    y: 500,
    texture: "ball1",
    group: "ball",
    body: bodyForSize(
      { width: 22, height: 22 },
      {
        shape: "circle",
        radius: 11,
        allowGravity: false,
        // A perfectly elastic ball: breakout has no friction and no drag, and
        // the ball must leave a wall as fast as it arrived.
        bounce: 1,
        collideWorldBounds: true,
      },
    ),
    data: {},
  })!;
  store.attachScript([ballId], { name: "BallController", src: scriptFilePath("BallController") });
  store.setScriptProp(ballId, 0, "launchX", -75);
  store.setScriptProp(ballId, 0, "launchY", -300);
  store.setScriptProp(ballId, 0, "english", 10);
  store.setScriptProp(ballId, 0, "restHeight", 50);
  store.setScriptProp(ballId, 0, "solidFloor", false);

  step({
    n: "6",
    title: "Place the paddle and the ball",
    body:
      `Both are ordinary objects with a body authored in the Inspector. The paddle is immovable, ` +
      `so the ball bounces off it instead of shoving it; the ball is a CIRCLE body with bounce 1, ` +
      `which is the only way it leaves a wall as fast as it arrived.\n\n` +
      `The four numbers that decide how the game feels — launch velocity, how far the ball rests ` +
      `above the paddle, and how much sideways speed a corner hit adds — are script properties, ` +
      `so they land in the scene file. In the original they are literals inside create() and ` +
      `hitPaddle().`,
    editor: "Place tool (B) → Paddle and Ball · Inspector → Body → circle, bounce 1, immovable",
    api:
      `store.addObject({ type: "sprite", texture: "ball1", group: "ball", body: { shape: "circle", radius: 11, bounce: 1 } })\n` +
      `store.setScriptProp(ballId, 0, "english", 10)`,
    friction:
      `The original disables ONE side of the world bounds — \`setBoundsCollision(true, true, true, ` +
      `false)\` — so the ball can fall out of play. Mosaic authors the bounds rectangle and whether ` +
      `a body is kept inside it, but not the four per-side flags, so a Mosaic breakout has no floor ` +
      `to lose the ball through and therefore no way to lose. BallController sets the flag itself, ` +
      `behind a "solid floor" property.`,
  });

  // -------------------------------------------------------- 7. the Brick prefab
  const seedBrickId = store.addObject({
    type: "sprite",
    name: "Brick",
    x: brickX(0),
    y: brickY(0),
    texture: ROWS[0].texture,
    group: "brick",
    body: bodyForSize(
      { width: CELL_W, height: CELL_H },
      { immovable: true, allowGravity: false, collideWorldBounds: false },
    ),
    data: {},
  })!;
  store.attachScript([seedBrickId], { name: "Brick", src: scriptFilePath("Brick") });
  store.setScriptProp(seedBrickId, 0, "points", ROWS[0].points);
  store.setScriptProp(seedBrickId, 0, "hits", 1);

  store.setSelection([seedBrickId]);
  store.createPrefab({ name: "Brick", objectId: seedBrickId, exposed: [], keepAsInstance: true });

  const POINTS_PATH = "scripts.0.props.points";
  const HITS_PATH = "scripts.0.props.hits";
  store.openPrefab("Brick");
  store.toggleExposed(POINTS_PATH);
  store.toggleExposed(HITS_PATH);
  store.pushPrefabSave();
  store.closePrefab();

  step({
    n: "7",
    title: "Build one brick, then promote it",
    body:
      `A prefab starts as something already on screen. One brick is built in the scene — sprite, ` +
      `immovable body, Brick attached, worth ${ROWS[0].points} — and promoted. Promoting rewrites that scene node ` +
      `IN PLACE, keeping its id, so it becomes the first of the sixty rather than being replaced ` +
      `by a copy of itself.\n\n` +
      `Two fields are exposed: points and hits. An exposed field is editable per instance and per ` +
      `variant; an unexposed one never appears in a level inspector at all. Everything else about ` +
      `a brick — its body, its behaviour — belongs to the definition, which is what keeps sixty ` +
      `bricks from drifting into sixty different objects.`,
    editor: "Select the brick → Prefab tab → Create prefab from selection… → Expose points, hits",
    api:
      `store.createPrefab({ name: "Brick", objectId: seedBrickId, keepAsInstance: true })\n` +
      `store.toggleExposed("${POINTS_PATH}")`,
  });

  // ------------------------------------------------------------- 8. variants
  for (const row of ROWS) {
    if (!row.variant) continue;
    store.createVariant("Brick", row.variant);
    store.openPrefab(row.variant);
    const root = store.prefabDoc!.rootId;
    store.setObjectProp(root, "texture", row.texture, "Set texture");
    store.setObjectProp(root, POINTS_PATH, row.points, "Set points");
    store.pushPrefabSave();
    store.closePrefab();
  }

  step({
    n: "8",
    title: "Five colours, as variants rather than five prefabs",
    body:
      `Each colour inherits Brick and states only what differs: a texture and a score. Its file ` +
      `holds a base and a diff — there is no second copy of the object anywhere.\n\n` +
      `That is the whole reason to bother. Changing the body, or what a brick does when it is hit, ` +
      `is one edit on Brick and it reaches all sixty. In the original the six colours are six ` +
      `frame names in one array and there is nothing to change: the behaviour is a method on the ` +
      `scene, and the only thing a brick "is" is a frame.`,
    editor: "Prefab tab → Variants → name Brick_Red → Create → set texture and points → Save",
    api:
      `store.createVariant("Brick", "Brick_Red")\n` +
      `store.setObjectProp(root, "texture", "red1")\n` +
      `store.setObjectProp(root, "${POINTS_PATH}", 50)`,
  });

  // -------------------------------------------------------------- 9. the wall
  let bricks = 1; // the seed brick is already instance one
  for (let row = 0; row < ROWS.length; row++) {
    for (let col = 0; col < COLS; col++) {
      if (row === 0 && col === 0) continue; // the seed
      const def = ROWS[row];
      store.addObject({
        type: "sprite",
        name: def.variant ?? "Brick",
        x: brickX(col),
        y: brickY(row),
        prefab: def.variant ?? "Brick",
        overrides: {},
        texture: def.texture,
        data: {},
      });
      bricks += 1;
    }
  }

  step({
    n: "9",
    title: "Lay the wall out",
    body:
      `${bricks} instances on a ${COLS} × ${ROWS.length} grid of ${CELL_W} × ${CELL_H} cells, the first centred at ` +
      `(${GRID_X}, ${GRID_Y}) — the same arithmetic the original hands to \`gridAlign\`. Each one is a node ` +
      `referencing a definition with an empty overrides map: a link, not a copy.\n\n` +
      `In the editor this is six drags with the grid snap on. What it is NOT is a loop, and that ` +
      `cuts both ways — the wall is now data you can see and rearrange, and it is also ${bricks} lines ` +
      `in the generated scene where the original had four.`,
    editor: "Assets dock → click a Brick variant → Place tool (B) → click along the grid",
    api: `store.addObject({ type: "sprite", prefab: "Brick_Red", x, y, overrides: {} })`,
    friction:
      `Nothing in the scene format says "a grid of these". Sixty placements are sixty objects in ` +
      `the scene file and sixty statements in the exported class; changing the wall's shape means ` +
      `moving sixty things rather than editing two numbers.`,
  });

  // ------------------------------------------------------------- 10. the HUD
  const hudId = store.addText("SCORE 0    LIVES 3    BRICKS 60", { x: 16, y: 14 })!;
  store.transact("Style HUD", () => {
    const hud = store.scene!.objects.find((o) => o.id === hudId)!;
    hud.name = "HUD";
    hud.originX = 0;
    hud.originY = 0;
    hud.text = { ...hud.text!, fontSize: 18, color: "#e8ecf4", fixed: true };
  });

  const bannerId = store.addText("", { x: 400, y: 380 })!;
  store.transact("Style banner", () => {
    const banner = store.scene!.objects.find((o) => o.id === bannerId)!;
    banner.name = "Banner";
    banner.text = { ...banner.text!, fontSize: 30, align: "center", color: "#e8ecf4", fixed: true };
  });

  step({
    n: "10",
    title: "Author the HUD as text objects",
    body:
      `The score readout and the end-of-round banner are objects in the scene, positioned on the ` +
      `canvas like everything else, and pinned to the camera.\n\n` +
      `The director finds them by name and writes into them. It does not create them — where the ` +
      `score sits and what size it is are content decisions, and content belongs in the scene.`,
    editor: "Toolbar → Text (T) · Inspector → Text → pin to camera",
    api: `store.addText("SCORE 0    LIVES 3", { x: 16, y: 14 })`,
  });

  // ---------------------------------------------------------- 11. collisions
  store.setCollisionRule("ball", "paddle", "ignore");
  store.setCollisionRule("ball", "brick", "ignore");
  store.setCollisionRule("brick", "brick", "ignore");
  store.setCollisionRule("paddle", "brick", "ignore");

  step({
    n: "11",
    title: "The collision matrix, and why this game cannot use it",
    body:
      `Both of breakout's collisions need the same two things at once: a bounce, and a callback. ` +
      `The ball has to come off the paddle at an angle that depends on where it hit, and a brick ` +
      `has to know it was the one that was hit.\n\n` +
      `The matrix can only give one or the other. A pair marked "collide" is emitted as ` +
      `\`physics.add.collider(a, b)\` with no handler; only a pair marked "overlap" gets a generated ` +
      `callback, and an overlap does not bounce. Marking these pairs "collide" and ALSO registering ` +
      `a collider in a script would put two colliders on the same pair, and the second one runs ` +
      `against bodies the first has already separated.\n\n` +
      `So both pairs are left ignored and the scripts register the colliders themselves — one call ` +
      `each, bounce and hook together. The groups are still worth authoring: they are what the ` +
      `export builds, and what a later rule would be written against.`,
    editor: "Inspector → Physics → Edit collision matrix…",
    api: `store.setCollisionRule("ball", "brick", "ignore")`,
    friction:
      `The collision matrix cannot express "collide, and tell me". Every interaction that needs a ` +
      `physical response AND a callback has to leave the matrix and move into a script, which is ` +
      `both of breakout's interactions — the entire game.`,
  });

  // ------------------------------------------------------------- 12. scripts
  for (const script of GAME_SCRIPTS) write(scriptFilePath(script.name), script.source);

  step({
    n: "12",
    title: "Write the four classes",
    body:
      `Mosaic never edits class source — it reads @property declarations out of it and renders ` +
      `them, and the values land in the scene. The four files are written into src/scripts/ and ` +
      `the editor indexes them; the fields set back in steps 5 and 6 are already waiting for them.\n\n` +
      `Nothing here reaches for another script. Bricks and the ball emit scene events and the ` +
      `director listens, so a brick does not need to know that a score exists — which is exactly ` +
      `what the original cannot do, because \`hitBrick\` is a method on the scene that reaches ` +
      `straight into \`this.bricks\`.`,
    editor: "Scripts tab → + Add → Create script… (or write the file; the watcher re-indexes)",
    api: GAME_SCRIPTS.map((s) => `${scriptFilePath(s.name)}  — ${s.role}`).join("\n"),
  });

  // -------------------------------------------------------------- 13. write
  write("README.md", readme(steps, bricks));
  for (const file of projectToFiles(store.project)) write(file.rel, file.contents);
  for (const file of generateFiles(store.project, store.scene!, "tsSceneClass")) {
    // The scaffold named the scene class Level_01 and main.ts imports it by
    // that name. Writing Level_01Scene.ts beside it would leave a second,
    // stale copy that nothing loads.
    const isScene = file.path.startsWith("src/scenes/");
    write(
      isScene ? "src/scenes/Level_01.ts" : file.path,
      isScene
        ? file.contents.replace("export class Level_01Scene", "export class Level_01")
        : file.contents,
    );
  }

  step({
    n: "13",
    title: "Save, and export the scene class",
    body:
      `Saving writes plain JSON: the manifest, the scene, and one file per prefab under ` +
      `src/prefabs/. Export then emits the Phaser scene class beside it, plus a class per prefab — ` +
      `six brick classes, one per variant, each constructing its own texture and body.\n\n` +
      `The scene CONSTRUCTS those classes, so behaviour authored on a prefab actually runs. ` +
      `Hand-written code inside a // <keep> region survives every later re-export.`,
    editor: "Export scene… → both · or ⌘S to save the folder",
    api: `projectToFiles(store.project)\ngenerateFiles(store.project, scene, "tsSceneClass")`,
  });

  return {
    root: plan.root,
    steps,
    files,
    stats: {
      objects: store.scene!.objects.length,
      bricks,
      prefabs: store.project.prefabs.length,
      variants: store.project.prefabs.filter((p) => p.base).length,
      scripts: GAME_SCRIPTS.length,
      assets: assets.length,
      undoDepth: store.stack().depth,
    },
  };
}

/**
 * The sample's own README, written by the builder so that regenerating the
 * project cannot leave a stale one behind.
 */
function readme(steps: BuildStep[], bricks: number): string {
  const friction = steps.filter((s) => s.friction);
  return `# Breakout

Phaser's \`breakout.js\` example, rebuilt as a Mosaic project.

    npm install
    npm run dev

The original is one file: \`public/src/games/breakout/breakout.js\` in the
[Phaser examples](https://github.com/phaserjs/examples). Everything in it — the
wall, the ball, the paddle, the rules — is written inside one scene class. This
is the same game with the same numbers, authored the way Mosaic asks: the wall
is ${bricks} objects in a scene file, a brick is a prefab with five colour
variants, and every behaviour is a script component whose tunable fields are
\`@property\` declarations the editor fills in.

It exists to answer a question rather than to be a game — can a whole, real,
already-written Phaser game be expressed in this editor's model, and does what
comes out the far end actually run? Both are checked in CI:

| command | what it proves |
|---|---|
| \`npm run breakout\` (repo root) | the project can be authored through the editor's own API |
| \`node scripts/verify-export.mjs breakout\` | the generated code typechecks and bundles |
| \`node scripts/parity/run.mjs breakout\` | the editor's play-test and the shipped build agree |
| \`node scripts/breakout/playtest.mjs\` | the game is playable: bricks break, lives are lost, the round ends |

## Layout

    src/scenes/Level_01.scene.json   the editor's source of truth
    src/scenes/Level_01.ts           generated from it — edit inside // <keep> markers
    src/prefabs/Brick*.ts            one class per prefab; the five variants are diffs
    src/scripts/                     ScriptComponent + the four behaviours
    assets/                          art, copied in by the editor
    mosaic.config.json               canvas, tile size, scale mode, physics

## What did not fit

${friction.map((s) => `**Step ${s.n} — ${s.title}.** ${s.friction!.replace(/\s+/g, " ")}`).join("\n\n")}

## Assets

The art is from the Phaser examples repo and is **not** covered by its MIT
licence — much of it comes from classic arcade games and stock art. It is here
so the sample renders; do not ship it.
`;
}

// ----------------------------------------------------------------------- CLI

const target = process.argv[2] ?? resolve(process.cwd(), "samples");
const result = buildBreakout(target);
console.log(`Built ${result.root}`);
console.log(
  `  ${result.files.length} files · ${result.stats.objects} objects · ` +
    `${result.stats.bricks} bricks · ${result.stats.prefabs} prefabs ` +
    `(${result.stats.variants} variants) · ${result.stats.undoDepth} undoable edits`,
);
writeFileSync(join(target, "breakout.build.json"), JSON.stringify(result, null, 2) + "\n");

const friction = result.steps.filter((s) => s.friction);
if (friction.length) {
  console.log(`\n  ${friction.length} things the editor could not express directly:`);
  for (const s of friction) console.log(`   · step ${s.n}: ${s.friction!.split(".")[0]}.`);
}
