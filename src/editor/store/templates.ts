import {
  BUILTIN_TILESET_ID,
  BUILTIN_TILESET_KEY,
  DEFAULT_GROUPS,
  SHAPE_DEFS,
  TILE_DEFS,
  TILE_SIZE,
  shapeDef,
  shapeTextureKey,
} from "../../shared/definitions";
import { newLid } from "../../shared/prefabs";
import { bodyForSize, type Size } from "../../shared/size";
import { placeholderTilesetDataUrl } from "../../shared/tilesetImage";
import {
  DEFAULT_CONFIG,
  type AssetDef,
  type CollisionRule,
  type ProjectConfig,
  type PrefabDef,
  type PrefabNode,
  type ProjectData,
  type SceneData,
  type SceneObject,
  type TileLayer,
} from "../../shared/types";
import { uid, uniqueName } from "./ids";

/**
 * Every template is a real, runnable scene — a camera, a tilemap layer and a
 * controllable object already wired — not an empty stub with TODOs. Empty
 * exists for people porting an existing game.
 */
export const SCENE_TEMPLATES = [
  {
    id: "empty",
    label: "Empty",
    blurb: "One scene, one camera. Nothing else.",
    includes: ["Level_01", "MainCamera", "mosaic.config.json"],
  },
  {
    id: "platformer",
    label: "Platformer",
    blurb: "Tilemap terrain, gravity, jump controller.",
    includes: ["Level_01", "Terrain layer", "Player.prefab", "arcade gravity 900", "camera follow", "wire_32 tileset"],
  },
  {
    id: "topdown",
    label: "Top-down",
    blurb: "8-way movement, wall collision, room bounds.",
    includes: ["Level_01", "Walls layer", "Player.prefab", "room bounds", "wire_32 tileset"],
  },
  {
    id: "runner",
    label: "Endless runner",
    blurb: "Scrolling chunks, spawner, score.",
    includes: ["Level_01", "Chunk.prefab", "Spawner", "score HUD", "wire_32 tileset"],
  },
] as const;

export type TemplateId = (typeof SCENE_TEMPLATES)[number]["id"];

const COLS = 25;
const ROWS = 15;

function emptyGrid(cols = COLS, rows = ROWS, fill = -1): number[][] {
  return Array.from({ length: rows }, () => Array<number>(cols).fill(fill));
}

export function makeTileLayer(
  name: string,
  grid?: number[][],
  dims?: { cols: number; rows: number; tile: number },
): TileLayer {
  const cols = dims?.cols ?? COLS;
  const rows = dims?.rows ?? ROWS;
  const tile = dims?.tile ?? TILE_SIZE;
  return {
    id: uid("layer"),
    name,
    kind: "tile",
    visible: true,
    locked: false,
    tilesetId: BUILTIN_TILESET_ID,
    tileWidth: tile,
    tileHeight: tile,
    cols,
    rows,
    data: grid ?? emptyGrid(cols, rows),
  };
}

/**
 * A plain sprite of one placeholder shape.
 *
 * There is no "type" to choose any more: an object is art plus components, so
 * what you pass is the art. Templates use this to build their starter prefabs;
 * everything a user places comes from an asset or a prefab.
 */
export function makeObject(
  shape: string,
  layerId: string,
  x: number,
  y: number,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  const def = shapeDef(shape);
  const base: SceneObject = {
    id: uid("obj"),
    name: def?.label ?? "Sprite",
    type: "sprite",
    layerId,
    parentId: null,
    x,
    y,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
    visible: true,
    texture: shapeTextureKey(shape),
    data: {},
  };
  return { ...base, ...overrides };
}

export function shapeSize(shape: string): Size {
  const def = shapeDef(shape);
  return { width: def?.width ?? 32, height: def?.height ?? 32 };
}

/** A body matching a placeholder shape's art. */
export function defaultBody(shape: string, patch: Partial<SceneObject["body"]> = {}): SceneObject["body"] {
  return bodyForSize(shapeSize(shape), patch);
}

/**
 * What a STARTER prefab publishes to its instances.
 *
 * Deliberately permissive. A real prefab should expose as little as possible —
 * that is the contract that stops fifty copies drifting apart — but a prefab
 * that ships with a project and publishes nothing greets a new user with a
 * column of locked fields and no explanation. These are the per-copy values
 * anyway; anything structural still belongs to the definition.
 */
export const STARTER_EXPOSED = [
  "scaleX",
  "scaleY",
  "rotation",
  "visible",
  "group",
  "playOnSpawn",
  "body.width",
  "body.height",
  "sounds.spawn",
  "sounds.overlap",
];

/**
 * A starter prefab: one shape, a body, a group, and nothing else.
 *
 * These are written INTO the project as ordinary prefab files. They are not
 * engine types and nothing downstream knows their names — rename them, edit
 * them, throw them away. They exist so a new project has something to place
 * before you have imported any art of your own.
 */
export function makePrefab(
  name: string,
  shape: string,
  opts: { group?: string; body?: Partial<SceneObject["body"]>; noBody?: boolean } = {},
): PrefabDef {
  const size = shapeSize(shape);
  const root: PrefabNode = {
    name,
    type: "sprite",
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
    visible: true,
    texture: shapeTextureKey(shape),
    group: opts.group,
    body: opts.noBody ? undefined : bodyForSize(size, opts.body),
    data: {},
    lid: newLid(),
    children: [],
  };
  return { name, exposed: [...STARTER_EXPOSED], root };
}

/** An instance of a starter prefab, placed in a template scene. */
function placePrefab(
  prefab: PrefabDef,
  layerId: string,
  x: number,
  y: number,
  name = prefab.name,
): SceneObject {
  const { children: _children, lid: _lid, ...rest } = structuredClone(prefab.root!);
  return {
    ...(rest as unknown as SceneObject),
    id: uid("obj"),
    name,
    layerId,
    parentId: null,
    x,
    y,
    prefab: prefab.name,
    overrides: {},
    data: {},
  };
}

/**
 * A template is a runnable scene plus the PREFABS it is built from — not a
 * scene of hardcoded engine types. The prefabs are written into the project as
 * ordinary files, so the first thing a new project contains is content the
 * author owns rather than nouns the editor insisted on.
 */
export interface TemplateResult {
  scene: SceneData;
  prefabs: PrefabDef[];
}

export function createSceneFromTemplate(
  key: string,
  name: string,
  template: TemplateId,
  config: ProjectConfig = DEFAULT_CONFIG,
): TemplateResult {
  const tile = config.tile;
  const cols = Math.max(4, Math.round(config.canvas.width / tile));
  const rows = Math.max(4, Math.round(config.canvas.height / tile));
  const dims = { cols, rows, tile };
  const grid = () => emptyGrid(cols, rows);

  const settings = {
    width: config.canvas.width,
    height: config.canvas.height,
    backgroundColor: "#e9e9ea",
    gravityY: template === "platformer" || template === "runner" ? 900 : 0,
    gridSize: tile,
  };

  const objectLayer = () => ({
    id: uid("layer"),
    name: "Objects",
    kind: "object" as const,
    visible: true,
    locked: false,
  });

  if (template === "empty") {
    // Nothing at all. Someone porting a game wants an empty folder, not a
    // starter set they have to delete first.
    return { scene: { key, name, settings, layers: [objectLayer()], objects: [] }, prefabs: [] };
  }

  const gravity = settings.gravityY > 0;
  const player = makePrefab("Player", "capsule", {
    group: "player",
    body: { allowGravity: gravity },
  });
  const pickup = makePrefab("Pickup", "star", {
    group: "pickup",
    body: { allowGravity: false },
  });

  if (template === "platformer") {
    const data = grid();
    for (let c = 0; c < cols; c++) {
      data[rows - 1][c] = 4;
      data[rows - 2][c] = 0;
    }
    for (let c = 4; c <= 8; c++) data[rows - 6][c] = 1;
    for (let c = 13; c <= Math.min(18, cols - 2); c++) data[rows - 8][c] = 1;
    const tiles = makeTileLayer("Terrain", data, dims);
    const objects = objectLayer();
    return {
      scene: {
        key,
        name,
        settings,
        layers: [tiles, objects],
        objects: [placePrefab(player, objects.id, 3 * tile, (rows - 4) * tile)],
      },
      prefabs: [player, pickup],
    };
  }

  if (template === "runner") {
    const data = grid();
    for (let c = 0; c < cols; c++) data[rows - 1][c] = 4;
    for (let c = 6; c <= 9; c++) data[rows - 5][c] = 1;
    for (let c = 15; c <= 18 && c < cols; c++) data[rows - 7][c] = 1;
    const tiles = makeTileLayer("Chunks", data, dims);
    const objects = objectLayer();
    const coins = [0, 1, 2].map((i) =>
      placePrefab(pickup, objects.id, (16 + i) * tile, (rows - 9) * tile, `Pickup ${i + 1}`),
    );
    return {
      scene: {
        key,
        name,
        settings,
        layers: [tiles, objects],
        objects: [placePrefab(player, objects.id, 2 * tile, (rows - 4) * tile), ...coins],
      },
      prefabs: [player, pickup],
    };
  }

  // top-down: walls around a room, zero gravity
  const data = emptyGrid(cols, rows, 0);
  for (let r = 4; r <= Math.min(7, rows - 2); r++) {
    for (let c = 3; c <= Math.min(7, cols - 2); c++) data[r][c] = 2;
  }
  for (let c = 0; c < cols; c++) {
    data[0][c] = 4;
    data[rows - 1][c] = 4;
  }
  for (let r = 0; r < rows; r++) {
    data[r][0] = 4;
    data[r][cols - 1] = 4;
  }
  const tiles = makeTileLayer("Walls", data, dims);
  const objects = objectLayer();
  return {
    scene: {
      key,
      name,
      settings,
      layers: [tiles, objects],
      objects: [placePrefab(player, objects.id, 6 * tile, Math.floor(rows / 2) * tile)],
    },
    prefabs: [player, pickup],
  };
}

export function placeholderTilesetAsset(): AssetDef {
  return {
    id: BUILTIN_TILESET_ID,
    key: BUILTIN_TILESET_KEY,
    kind: "tileset",
    path: "assets/placeholder-tiles.png",
    url: placeholderTilesetDataUrl(),
    width: TILE_DEFS.length * TILE_SIZE,
    height: TILE_SIZE,
    frameWidth: TILE_SIZE,
    frameHeight: TILE_SIZE,
    margin: 0,
    spacing: 0,
    tileCollides: TILE_DEFS.filter((t) => t.collides).map((t) => t.index),
    generated: true,
  };
}

/** Placeholder object art registered as assets so the dock has something real. */
export function placeholderObjectAssets(): AssetDef[] {
  return SHAPE_DEFS.map((def) => ({
    id: `asset-shape-${def.shape}`,
    key: shapeTextureKey(def.shape),
    kind: "image" as const,
    path: `assets/shape-${def.shape}.png`,
    url: "",
    width: def.width,
    height: def.height,
    generated: true,
  }));
}

/**
 * Starting rules for the starting groups. Exported because the scaffold needs
 * the same table — it had its own copy, which drifted the moment the default
 * groups changed and crashed on a name that no longer existed.
 */
export function defaultMatrix(groups: string[] = DEFAULT_GROUPS): Record<string, Record<string, CollisionRule>> {
  const matrix: Record<string, Record<string, CollisionRule>> = {};
  for (const a of groups) {
    matrix[a] = {};
    for (const b of groups) matrix[a][b] = "ignore";
  }
  const set = (a: string, b: string, rule: CollisionRule) => {
    if (!matrix[a] || !matrix[b]) return;
    matrix[a][b] = rule;
    matrix[b][a] = rule;
  };
  // Sensible starting rules for the starting groups. Both are project data:
  // rename a group or delete it and the matrix follows.
  set("player", "solid", "collide");
  set("player", "pickup", "overlap");
  set("player", "hazard", "overlap");
  set("player", "trigger", "overlap");
  set("solid", "solid", "collide");
  return matrix;
}

export function createStarterProject(): ProjectData {
  const { scene: level, prefabs } = createSceneFromTemplate(
    "Level_01",
    "Level 01",
    "platformer",
  );
  const objLayer = level.layers.find((l) => l.kind === "object")!;
  const pickup = prefabs.find((p) => p.name === "Pickup")!;

  // A row of pickups, deliberately repeated, so the prefab workflow has
  // something to be demonstrated on. Names stay unique: they key the generated
  // scene's objects map.
  for (let i = 0; i < 4; i++) {
    const coin = placePrefab(
      pickup,
      objLayer.id,
      (13 + i) * TILE_SIZE + 16,
      (ROWS - 9) * TILE_SIZE,
    );
    coin.name = uniqueName(coin.name, level.objects.map((o) => o.name));
    level.objects.push(coin);
  }

  return {
    name: "Starter Project",
    config: structuredClone(DEFAULT_CONFIG),
    scenes: [level],
    prefabs,
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets()],
    anims: [],
    groups: [...DEFAULT_GROUPS],
    collision: defaultMatrix(DEFAULT_GROUPS),
  };
}
