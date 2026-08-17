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
import type {
  AssetDef,
  CollisionRule,
  ProjectData,
  SceneData,
  SceneObject,
  TileLayer,
} from "../../shared/types";
import { uid } from "./ids";

export const SCENE_TEMPLATES = [
  { id: "empty", label: "Empty", blurb: "One object layer, nothing else." },
  {
    id: "platformer",
    label: "Platformer",
    blurb: "Ground tile layer, gravity, a player with an arcade body.",
  },
  {
    id: "topdown",
    label: "Top-down",
    blurb: "Grass field, zero gravity, a player that walks in 4 directions.",
  },
] as const;

export type TemplateId = (typeof SCENE_TEMPLATES)[number]["id"];

const COLS = 25;
const ROWS = 15;

function emptyGrid(cols = COLS, rows = ROWS, fill = -1): number[][] {
  return Array.from({ length: rows }, () => Array<number>(cols).fill(fill));
}

export function makeTileLayer(name: string, grid?: number[][]): TileLayer {
  return {
    id: uid("layer"),
    name,
    kind: "tile",
    visible: true,
    locked: false,
    tilesetId: BUILTIN_TILESET_ID,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    cols: COLS,
    rows: ROWS,
    data: grid ?? emptyGrid(),
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
): SceneData {
  const settings = {
    width: COLS * TILE_SIZE,
    height: ROWS * TILE_SIZE,
    backgroundColor: "#e9e9ea",
    gravityY: template === "platformer" ? 900 : 0,
    gridSize: TILE_SIZE,
  };

  if (template === "empty") {
    const objects: SceneObject[] = [];
    const objLayer = { id: uid("layer"), name: "Objects", kind: "object" as const, visible: true, locked: false };
    return { key, name, settings, layers: [objLayer], objects };
  }

  if (template === "platformer") {
    const grid = emptyGrid();
    for (let c = 0; c < COLS; c++) {
      grid[ROWS - 1][c] = 4;
      grid[ROWS - 2][c] = 0;
    }
    for (let c = 4; c <= 8; c++) grid[ROWS - 6][c] = 1;
    for (let c = 13; c <= 18; c++) grid[ROWS - 8][c] = 1;
    const tiles = makeTileLayer("Ground", grid);
    const objLayer = { id: uid("layer"), name: "Objects", kind: "object" as const, visible: true, locked: false };
    const player = makeObject("player", objLayer.id, 3 * TILE_SIZE, (ROWS - 4) * TILE_SIZE, {
      body: defaultBody("player"),
    });
    const spawn = makeObject("spawn", objLayer.id, 3 * TILE_SIZE, (ROWS - 4) * TILE_SIZE);
    return { key, name, settings, layers: [tiles, objLayer], objects: [spawn, player] };
  }

  const grid = emptyGrid(COLS, ROWS, 0);
  for (let r = 4; r <= 7; r++) for (let c = 3; c <= 7; c++) grid[r][c] = 2;
  for (let c = 0; c < COLS; c++) {
    grid[0][c] = 4;
    grid[ROWS - 1][c] = 4;
  }
  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = 4;
    grid[r][COLS - 1] = 4;
  }
  const tiles = makeTileLayer("Ground", grid);
  const objLayer = { id: uid("layer"), name: "Objects", kind: "object" as const, visible: true, locked: false };
  const player = makeObject("player", objLayer.id, 6 * TILE_SIZE, 10 * TILE_SIZE, {
    body: { ...defaultBody("player")!, allowGravity: false },
  });
  return { key, name, settings, layers: [tiles, objLayer], objects: [player] };
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

  // A row of coins, deliberately repeated — workflow 5 turns these into a prefab.
  for (let i = 0; i < 4; i++) {
    level.objects.push(
      makeObject("coin", objLayer.id, (13 + i) * TILE_SIZE + 16, (ROWS - 9) * TILE_SIZE, {
        body: { ...defaultBody("coin")!, allowGravity: false },
      }),
    );
  }
  level.objects.push(
    makeObject("enemy", objLayer.id, 18 * TILE_SIZE, (ROWS - 4) * TILE_SIZE, {
      body: defaultBody("enemy"),
    }),
  );
  level.objects.push(makeObject("exit", objLayer.id, 23 * TILE_SIZE, (ROWS - 4) * TILE_SIZE));

  return {
    name: "Starter Project",
    scenes: [level],
    prefabs: [],
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets()],
    anims: [],
    groups: [...DEFAULT_GROUPS],
    collision: defaultMatrix(DEFAULT_GROUPS),
  };
}
