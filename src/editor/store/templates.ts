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
import {
  MAP_DIR,
  describeTiledMap,
  tiledFromGrid,
  tiledToDataUrl,
  type GridLayer,
} from "../../shared/tiled";
import { placeholderTilesetDataUrl } from "../../shared/tilesetImage";
import {
  DEFAULT_CONFIG,
  type AssetDef,
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
    blurb: "Tiled terrain, gravity, jump controller.",
    includes: ["Level_01", "Level_01.tmj (Tiled)", "Player.prefab", "arcade gravity 900", "placeholder tileset"],
  },
  {
    id: "topdown",
    label: "Top-down",
    blurb: "8-way movement, wall collision, room bounds.",
    includes: ["Level_01", "Level_01.tmj (Tiled)", "Player.prefab", "room bounds", "placeholder tileset"],
  },
  {
    id: "runner",
    label: "Endless runner",
    blurb: "Scrolling chunks, spawner, score.",
    includes: ["Level_01", "Level_01.tmj (Tiled)", "Player.prefab", "Pickup.prefab", "placeholder tileset"],
  },
] as const;

export type TemplateId = (typeof SCENE_TEMPLATES)[number]["id"];

const COLS = 25;
const ROWS = 15;

function emptyGrid(cols = COLS, rows = ROWS, fill = -1): number[][] {
  return Array.from({ length: rows }, () => Array<number>(cols).fill(fill));
}

/** One tile layer of a Tiled map, as a row in the scene's layer list. */
export function makeTileLayer(name: string, map: string, layer = name): TileLayer {
  return { id: uid("layer"), name, kind: "tile", visible: true, locked: false, map, layer };
}

export const mapPathFor = (sceneKey: string) => `${MAP_DIR}/${sceneKey}.tmj`;

/**
 * The terrain a template starts with, as a Tiled map.
 *
 * It is an ordinary `.tmj` drawn with the placeholder tileset: open it in
 * Tiled and it is yours to repaint, re-tile or throw away. The asset carries
 * the map as a data: URL until the project is saved into a folder, at which
 * point it becomes the file at `path`.
 */
export function makeTemplateMap(
  sceneKey: string,
  layers: GridLayer[],
  dims: { cols: number; rows: number; tile: number },
): AssetDef {
  const path = mapPathFor(sceneKey);
  const tileset = placeholderTilesetAsset();
  const map = tiledFromGrid({
    cols: dims.cols,
    rows: dims.rows,
    tileWidth: dims.tile,
    tileHeight: dims.tile,
    layers,
    tileset: {
      name: BUILTIN_TILESET_KEY,
      // Relative to the map, which is how Tiled writes it.
      image: "../placeholder-tiles.png",
      imageWidth: tileset.width,
      imageHeight: tileset.height,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      collides: TILE_DEFS.filter((t) => t.collides).map((t) => t.index),
    },
  });
  return {
    id: uid("asset"),
    key: mapKeyFor(sceneKey),
    kind: "tilemap",
    path,
    url: tiledToDataUrl(map),
    width: dims.cols * dims.tile,
    height: dims.rows * dims.tile,
    tilemap: describeTiledMap(map, path, [tileset]),
  };
}

export function mapKeyFor(sceneKey: string): string {
  return sceneKey.replace(/[^\w]+/g, "_");
}

export function shapeSize(shape: string): Size {
  const def = shapeDef(shape);
  return { width: def?.width ?? 32, height: def?.height ?? 32 };
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
  /** The Tiled map the scene stands on, when the template has terrain. */
  assets: AssetDef[];
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
    return {
      scene: { key, name, settings, layers: [objectLayer()], objects: [] },
      prefabs: [],
      assets: [],
    };
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
    const map = makeTemplateMap(key, [{ name: "Terrain", data }], dims);
    const tiles = makeTileLayer("Terrain", map.key);
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
      assets: [map],
    };
  }

  if (template === "runner") {
    const data = grid();
    for (let c = 0; c < cols; c++) data[rows - 1][c] = 4;
    for (let c = 6; c <= 9; c++) data[rows - 5][c] = 1;
    for (let c = 15; c <= 18 && c < cols; c++) data[rows - 7][c] = 1;
    const map = makeTemplateMap(key, [{ name: "Chunks", data }], dims);
    const tiles = makeTileLayer("Chunks", map.key);
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
      assets: [map],
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
  const map = makeTemplateMap(key, [{ name: "Walls", data }], dims);
  const tiles = makeTileLayer("Walls", map.key);
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
    assets: [map],
  };
}

/**
 * The tileset the template maps are drawn with. An ordinary image as far as
 * the project is concerned: which tiles it holds, and which are solid, is in
 * the map.
 */
export function placeholderTilesetAsset(): AssetDef {
  return {
    id: BUILTIN_TILESET_ID,
    key: BUILTIN_TILESET_KEY,
    kind: "image",
    path: "assets/placeholder-tiles.png",
    url: placeholderTilesetDataUrl(),
    width: TILE_DEFS.length * TILE_SIZE,
    height: TILE_SIZE,
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

export function createStarterProject(): ProjectData {
  const { scene: level, prefabs, assets } = createSceneFromTemplate(
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
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets(), ...assets],
    anims: [],
    groups: [...DEFAULT_GROUPS],
  };
}
