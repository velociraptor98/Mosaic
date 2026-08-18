import {
  BUILTIN_TILESET_ID,
  BUILTIN_TILESET_KEY,
  DEFAULT_GROUPS,
  OBJECT_DEFS,
  TILE_DEFS,
  TILE_SIZE,
  objectDef,
  objectTextureKey,
} from "../../shared/definitions";
import { placeholderTilesetDataUrl } from "../../shared/tilesetImage";
import {
  DEFAULT_CONFIG,
  type AssetDef,
  type CollisionRule,
  type ProjectConfig,
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

export function makeObject(
  type: string,
  layerId: string,
  x: number,
  y: number,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  const def = objectDef(type);
  const base: SceneObject = {
    id: uid(type),
    name: def?.label ?? type,
    type,
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
    texture: objectTextureKey(type),
    group: def?.group,
    data: structuredClone(def?.data ?? {}),
  };
  return { ...base, ...overrides };
}

export function defaultBody(type: string): SceneObject["body"] {
  const def = objectDef(type);
  const w = def?.width ?? 32;
  const h = def?.height ?? 32;
  return {
    shape: "box",
    width: w,
    height: h,
    radius: Math.min(w, h) / 2,
    offsetX: 0,
    offsetY: 0,
    immovable: type === "crate",
    allowGravity: type !== "coin" && type !== "spawn" && type !== "exit",
    bounce: 0,
  };
}

export function createSceneFromTemplate(
  key: string,
  name: string,
  template: TemplateId,
  config: ProjectConfig = DEFAULT_CONFIG,
): SceneData {
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
    return { key, name, settings, layers: [objectLayer()], objects: [] };
  }

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
    const player = makeObject("player", objects.id, 3 * tile, (rows - 4) * tile, {
      body: defaultBody("player"),
    });
    const spawn = makeObject("spawn", objects.id, 3 * tile, (rows - 4) * tile);
    return { key, name, settings, layers: [tiles, objects], objects: [spawn, player] };
  }

  if (template === "runner") {
    const data = grid();
    for (let c = 0; c < cols; c++) data[rows - 1][c] = 4;
    for (let c = 6; c <= 9; c++) data[rows - 5][c] = 1;
    for (let c = 15; c <= 18 && c < cols; c++) data[rows - 7][c] = 1;
    const tiles = makeTileLayer("Chunks", data, dims);
    const objects = objectLayer();
    const player = makeObject("player", objects.id, 2 * tile, (rows - 4) * tile, {
      body: defaultBody("player"),
    });
    const coins = [0, 1, 2].map((i) =>
      makeObject("coin", objects.id, (16 + i) * tile, (rows - 9) * tile, {
        name: `Coin ${i + 1}`,
        body: { ...defaultBody("coin")!, allowGravity: false },
      }),
    );
    return { key, name, settings, layers: [tiles, objects], objects: [player, ...coins] };
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
  const player = makeObject("player", objects.id, 6 * tile, Math.floor(rows / 2) * tile, {
    body: { ...defaultBody("player")!, allowGravity: false },
  });
  return { key, name, settings, layers: [tiles, objects], objects: [player] };
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
  return OBJECT_DEFS.map((def) => ({
    id: `asset-${def.type}`,
    key: objectTextureKey(def.type),
    kind: "image" as const,
    path: `assets/${def.type}.png`,
    url: "",
    width: def.width,
    height: def.height,
    generated: true,
  }));
}

function defaultMatrix(groups: string[]): Record<string, Record<string, CollisionRule>> {
  const matrix: Record<string, Record<string, CollisionRule>> = {};
  for (const a of groups) {
    matrix[a] = {};
    for (const b of groups) matrix[a][b] = "ignore";
  }
  const set = (a: string, b: string, rule: CollisionRule) => {
    matrix[a][b] = rule;
    matrix[b][a] = rule;
  };
  set("player", "solid", "collide");
  set("player", "enemy", "overlap");
  set("player", "pickup", "overlap");
  set("player", "trigger", "overlap");
  set("enemy", "solid", "collide");
  set("solid", "solid", "collide");
  return matrix;
}

export function createStarterProject(): ProjectData {
  const level = createSceneFromTemplate("Level_01", "Level 01", "platformer");
  const objLayer = level.layers.find((l) => l.kind === "object")!;

  // A row of coins, deliberately repeated — workflow 5 turns these into a
  // prefab. Names stay unique: they key the generated scene's objects map.
  for (let i = 0; i < 4; i++) {
    const coin = makeObject("coin", objLayer.id, (13 + i) * TILE_SIZE + 16, (ROWS - 9) * TILE_SIZE, {
      body: { ...defaultBody("coin")!, allowGravity: false },
    });
    coin.name = uniqueName(coin.name, level.objects.map((o) => o.name));
    level.objects.push(coin);
  }
  level.objects.push(
    makeObject("enemy", objLayer.id, 18 * TILE_SIZE, (ROWS - 4) * TILE_SIZE, {
      body: defaultBody("enemy"),
    }),
  );
  level.objects.push(makeObject("exit", objLayer.id, 23 * TILE_SIZE, (ROWS - 4) * TILE_SIZE));

  return {
    name: "Starter Project",
    config: structuredClone(DEFAULT_CONFIG),
    scenes: [level],
    prefabs: [],
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets()],
    anims: [],
    groups: [...DEFAULT_GROUPS],
    collision: defaultMatrix(DEFAULT_GROUPS),
  };
}
