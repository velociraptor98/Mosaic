import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { generateProjectFiles } from "../../src/editor/export/generate";
import { DEFAULT_OPTIONS, planScaffold } from "../../src/editor/project/scaffold";
import { projectToFiles } from "../../src/editor/project/serialize";
import { ProjectStore } from "../../src/editor/store/project";
import { shapeTextureKey } from "../../src/shared/definitions";
import { scriptFilePath } from "../../src/shared/scripts";
import { bodyForSize } from "../../src/shared/size";
import { DEFAULT_PATHS, type AssetDef, type ProjectConfig } from "../../src/shared/types";
import { parsePhaserAtlas } from "../../src/editor/assets/atlasJson";
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
 * `projectToFiles` and `generateProjectFiles` write the result. There is no
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

/** The packed sheet the original loads, and the document that names its frames. */
const SHEET = "breakout.png";
const SHEET_DOC = "breakout.json";
const SHEET_KEY = "breakout";
const SHEET_SIZE = { width: 504, height: 121 };

/**
 * The wall, top row first — the same six colours in the same order as the
 * original's `frame: [ 'blue1', 'red1', ... ]`, with a score attached to each
 * because the original keeps none.
 */
const ROWS: { variant: string | null; frame: string; points: number }[] = [
  { variant: null, frame: "blue1", points: 60 },
  { variant: "Brick_Red", frame: "red1", points: 50 },
  { variant: "Brick_Green", frame: "green1", points: 40 },
  { variant: "Brick_Yellow", frame: "yellow1", points: 30 },
  { variant: "Brick_Silver", frame: "silver1", points: 20 },
  { variant: "Brick_Purple", frame: "purple1", points: 10 },
];

/** The original's `gridAlign`, as plain arithmetic: 10 × 6 cells of 64 × 32. */
const COLS = 10;
const CELL_W = 64;
const CELL_H = 32;
const GRID_X = 112;
const GRID_Y = 100;

const brickX = (col: number) => GRID_X + col * CELL_W;
const brickY = (row: number) => GRID_Y + row * CELL_H;

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
    const { groups, scripts } = this.layout;

    // Breakout's two collisions. Each tells the scripts on both objects that
    // they touched, which is where the bounce angle and the broken brick live.
    this.physics.add.collider(groups.ball, groups.paddle, (a, b) => scripts.contact(a, b, "collide"));
    this.physics.add.collider(groups.ball, groups.brick, (a, b) => scripts.contact(a, b, "collide"));
  }
}
`;

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
    // The floor is OPEN. Three walls stop the ball; the fourth lets it go,
    // which is the only reason a life can be lost.
    scene.settings.bounds = { left: true, right: true, top: true, bottom: false };
  });
  step({
    n: "2",
    title: "Set the court up",
    body:
      `No gravity: in breakout the ball is not falling, it is travelling. The background is scene ` +
      `data like everything else, so the exported game reads the colour from the same field the ` +
      `editor writes.\n\n` +
      `The FLOOR IS OPEN. Arcade's world bounds are one rectangle with a flag per side, and three ` +
      `of the four stop the ball while the fourth lets it through — which is the whole reason a ` +
      `life can be lost. It is four checkboxes under Scene → World edges, and it lands in the ` +
      `scene file like the gravity above it.`,
    editor: "Inspector → Scene → Gravity Y = 0, Background #12141c, World edges → Bottom off",
    api: `scene.settings.bounds = { left: true, right: true, top: true, bottom: false }`,
  });

  // ---------------------------------------------------------------- 3. art
  // The sheet and the document that names its frames, imported together the
  // way the picker takes them.
  const sheetBytes = readFileSync(join(ART, SHEET));
  write(`assets/${SHEET}`, sheetBytes.toString("base64"), "base64");
  write(`assets/${SHEET_DOC}`, readFileSync(join(ART, SHEET_DOC), "utf8"));

  const frames = parsePhaserAtlas(readFileSync(join(ART, SHEET_DOC), "utf8"));
  if (!frames?.length) throw new Error(`${SHEET_DOC} is not a Phaser atlas document.`);

  const assets: AssetDef[] = [
    {
      id: `asset-${SHEET_KEY}`,
      key: SHEET_KEY,
      kind: "atlas",
      path: `assets/${SHEET}`,
      url: `data:image/png;base64,${sheetBytes.toString("base64")}`,
      width: SHEET_SIZE.width,
      height: SHEET_SIZE.height,
      frames,
    },
  ];
  store.importAssets(assets);

  step({
    n: "3",
    title: "Import the art",
    body:
      `The sheet and its document, picked together and copied into assets/ — Mosaic never ` +
      `references art in place. One \`load.atlas\` in the exported game, exactly as the original ` +
      `does it, and ${frames.length} frames that keep the names the packer gave them.\n\n` +
      `Those names are the part that matters: the scene says frame "blue1", not frame 7. Mosaic ` +
      `can still SLICE a sheet it has never seen — by grid, or by flood-filling opaque islands — ` +
      `but a sheet that arrives already packed is read rather than re-cut.`,
    editor: "Assets dock → Import… → breakout.png and breakout.json together",
    api: `store.importAssets([{ kind: "atlas", frames: parsePhaserAtlas(doc) }])`,
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
    texture: SHEET_KEY,
    frame: "paddle1",
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
    texture: SHEET_KEY,
    frame: "ball1",
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
  });

  // -------------------------------------------------------- 7. the Brick prefab
  const seedBrickId = store.addObject({
    type: "sprite",
    name: "Brick",
    x: brickX(0),
    y: brickY(0),
    texture: SHEET_KEY,
    frame: ROWS[0].frame,
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
    store.setObjectProp(root, "frame", row.frame, "Set frame");
    store.setObjectProp(root, POINTS_PATH, row.points, "Set points");
    store.pushPrefabSave();
    store.closePrefab();
  }

  step({
    n: "8",
    title: "Five colours, as variants rather than five prefabs",
    body:
      `Each colour inherits Brick and states only what differs: a frame and a score. Its file ` +
      `holds a base and a diff — there is no second copy of the object anywhere.\n\n` +
      `That is the whole reason to bother. Changing the body, or what a brick does when it is hit, ` +
      `is one edit on Brick and it reaches all sixty. In the original the six colours are six ` +
      `frame names in one array and there is nothing to change: the behaviour is a method on the ` +
      `scene, and the only thing a brick "is" is a frame.`,
    editor: "Prefab tab → Variants → name Brick_Red → Create → set texture and points → Save",
    api:
      `store.createVariant("Brick", "Brick_Red")\n` +
      `store.setObjectProp(root, "frame", "red1")\n` +
      `store.setObjectProp(root, "${POINTS_PATH}", 50)`,
  });

  // -------------------------------------------------------------- 9. the wall
  // One brick per ROW is placed by hand; Fill grid stamps each into its ten.
  // The seed from step 7 is already the first cell of the top row.
  let bricks = 1;
  const rowSeeds: string[] = [seedBrickId];
  for (let row = 1; row < ROWS.length; row++) {
    const def = ROWS[row];
    const id = store.addObject({
      type: "sprite",
      name: def.variant!,
      x: brickX(0),
      y: brickY(row),
      prefab: def.variant!,
      overrides: {},
      texture: SHEET_KEY,
      frame: def.frame,
      data: {},
    })!;
    rowSeeds.push(id);
    bricks += 1;
  }
  for (const seed of rowSeeds) {
    store.setSelection([seed]);
    bricks += store.fillGrid([seed], { cols: COLS, rows: 1, dx: CELL_W, dy: 0 });
  }

  step({
    n: "9",
    title: "Lay the wall out",
    body:
      `${bricks} instances on a ${COLS} × ${ROWS.length} grid of ${CELL_W} × ${CELL_H} cells, the first centred at ` +
      `(${GRID_X}, ${GRID_Y}) — the same arithmetic the original hands to \`gridAlign\`. Each one is a node ` +
      `referencing a definition with an empty overrides map: a link, not a copy.\n\n` +
      `Six objects are placed by hand, one per colour, and Fill grid stamps each along its row. ` +
      `The scene still stores ${bricks} objects rather than a rule that makes them — a level is data, not ` +
      `a loop, and every brick stays selectable and movable afterwards. What the grid removes is ` +
      `the fifty-four clicks, not the fifty-four objects.`,
    editor: "Place one brick per row → select it → Fill grid… → 10 × 1, step 64",
    api: `store.fillGrid([seed], { cols: ${COLS}, rows: 1, dx: ${CELL_W}, dy: 0 })`,
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
  // Not an edit in the editor: the scene's own code says what collides.
  write("src/scenes/Level_01.ts", LEVEL_SCENE);

  step({
    n: "11",
    title: "Say what collides, in the scene's own code",
    body:
      `Both of breakout's collisions are the same shape: a bounce, and something that wants to know ` +
      `it happened. The ball has to leave the paddle at an angle that depends on where it hit, and ` +
      `a brick has to know it was the one that was hit.\n\n` +
      `The layout sorts the objects into groups — ball, paddle, brick — and hands the groups back. ` +
      `Two lines in the scene class add the colliders, the way any Phaser game would, and each ` +
      `passes the contact on to the scripts of the two objects involved. So a brick's behaviour ` +
      `lives on the Brick PREFAB and reaches all sixty instances without the scene naming any of ` +
      `them, and there is one collider per pair: the one doing the physics is the one reporting it.`,
    editor: "your editor → src/scenes/Level_01.ts",
    api: `this.physics.add.collider(groups.ball, groups.brick, (a, b) => scripts.contact(a, b, "collide"))`,
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
  // The same files a save writes: the layout is rewritten, and a class that is
  // "yours" is written only if the scaffold has not already put one there.
  for (const file of generateProjectFiles(store.project)) {
    if (file.owner === "yours" && files.some((f) => f.rel === file.path)) continue;
    write(file.path, file.contents);
  }

  step({
    n: "13",
    title: "Save — the layout is written with it",
    body:
      `Saving writes plain JSON: the manifest, the scene, and one file per prefab under ` +
      `src/prefabs/. The same save writes a *.layout.ts beside each — generated, rewritten every ` +
      `time, never edited — and a class per scene and per prefab that is written once and is ` +
      `yours from then on.\n\n` +
      `The scene layout CONSTRUCTS the prefab classes, so behaviour written on one actually runs, ` +
      `and the five variants extend Brick rather than restating it. Nothing is merged, so there ` +
      `is nothing to protect with markers.`,
    editor: "⌘S — or nothing at all: the folder autosaves",
    api: `projectToFiles(store.project)\ngenerateProjectFiles(store.project)`,
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
already-written Phaser game be laid out in this editor and still run as an
ordinary Phaser project? \`npm run breakout\` at the repo root rebuilds it by
driving the editor's own API.

## Layout

One rule: **\`*.layout.ts\` is generated, everything else is yours.**

    src/main.ts                      the game config and scene list — yours
    src/scenes/Level_01.ts           the scene class — yours
    src/scenes/Level_01.layout.ts    what the editor placed — generated on save
    src/scenes/Level_01.scene.json   the data the editor edits
    src/prefabs/Brick*.ts            a class per prefab — yours; variants extend Brick
    src/prefabs/Brick*.layout.ts     each prefab's art and body — generated
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
