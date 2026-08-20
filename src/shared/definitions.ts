/**
 * Built-in content: the placeholder tileset and the object types a fresh
 * project starts with. A real project replaces these by importing art —
 * every lookup below is keyed by string, so imported assets slot straight in.
 */

export interface TileDef {
  index: number;
  name: string;
  color: number;
  /** Default collision flag baked into the generated placeholder tileset. */
  collides: boolean;
}

/**
 * Placeholder tiles are drawn from the reference document's tonal ramps —
 * neutral, accent and accent-2 — picked at steps far enough apart to stay
 * distinguishable by VALUE, not only by hue. The one hazard tile borrows the
 * danger hue, which is the only warm note in the palette.
 */
export const TILE_DEFS: TileDef[] = [
  { index: 0, name: "Grass", color: 0x7e9cb8, collides: false }, // accent-2-500
  { index: 1, name: "Stone", color: 0xb7b7ba, collides: true },  // neutral-400
  { index: 2, name: "Water", color: 0x94bce3, collides: false }, // accent-400
  { index: 3, name: "Sand", color: 0xd4d4d7, collides: false },  // neutral-300
  { index: 4, name: "Wall", color: 0x5d5d60, collides: true },   // neutral-700
  { index: 5, name: "Brick", color: 0x7a7a7d, collides: true },  // neutral-600
  { index: 6, name: "Ice", color: 0xd6ebff, collides: true },    // accent-200
  { index: 7, name: "Lava", color: 0xa6595e, collides: false },  // danger
];

export type ObjectShape = "circle" | "star" | "triangle" | "diamond" | "capsule" | "box";

/**
 * A procedural placeholder sprite.
 *
 * These are SHAPES, not roles. A previous version of this file listed six game
 * nouns — player, coin, enemy, crate — which read as engine types the format
 * cared about. It never did: nothing downstream branches on an object's type.
 * All they ever supplied was a sprite, a size and some defaults, and a project
 * that is not a platformer should not have to start from another game's nouns.
 *
 * What you place is an ASSET or a PREFAB. These are the assets a new project
 * has before you import any art of your own.
 */
export interface ShapeDef {
  shape: ObjectShape;
  label: string;
  color: number;
  width: number;
  height: number;
}

/** Same tonal ramps as the tiles, so a scene reads as one drawing. */
export const SHAPE_DEFS: ShapeDef[] = [
  { shape: "capsule", label: "Capsule", color: 0x416180, width: 28, height: 40 },
  { shape: "box", label: "Box", color: 0x7a7a7d, width: 32, height: 32 },
  { shape: "circle", label: "Circle", color: 0x749dc4, width: 32, height: 32 },
  { shape: "triangle", label: "Triangle", color: 0xa6595e, width: 28, height: 36 },
  { shape: "star", label: "Star", color: 0x94bce3, width: 24, height: 24 },
  { shape: "diamond", label: "Diamond", color: 0x7e9cb8, width: 24, height: 24 },
];

/**
 * Collision groups a fresh project starts with. Groups are project data and
 * always were — these are a starting point, not a fixed set, and the project
 * panel can add, rename and remove them.
 */
export const DEFAULT_GROUPS = ["player", "solid", "pickup", "hazard", "trigger"];

export const BUILTIN_TILESET_ID = "tileset-placeholder";
export const BUILTIN_TILESET_KEY = "placeholder-tiles";
export const TILE_SIZE = 32;

export function shapeDef(shape: string): ShapeDef | undefined {
  return SHAPE_DEFS.find((d) => d.shape === shape);
}

export function shapeTextureKey(shape: string): string {
  return `shape-${shape}`;
}

/**
 * Texture keys written by builds that named their placeholders after game
 * roles, mapped to the shape each one drew. Read on project load so a folder
 * written before the rename still opens with its art attached.
 */
export const LEGACY_OBJECT_TEXTURES: Record<string, string> = {
  "obj-player": shapeTextureKey("capsule"),
  "obj-crate": shapeTextureKey("box"),
  "obj-enemy": shapeTextureKey("triangle"),
  "obj-coin": shapeTextureKey("star"),
  "obj-spawn": shapeTextureKey("diamond"),
  "obj-exit": shapeTextureKey("diamond"),
};

export function tileDef(index: number): TileDef | undefined {
  return TILE_DEFS.find((t) => t.index === index);
}
