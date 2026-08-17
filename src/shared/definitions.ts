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

export type ObjectShape = "circle" | "star" | "triangle" | "diamond" | "capsule";

export interface ObjectDef {
  type: string;
  label: string;
  color: number;
  shape: ObjectShape;
  /** Default collision group for newly placed objects of this type. */
  group: string;
  /** Default per-instance data written when one is placed. */
  data: Record<string, unknown>;
  width: number;
  height: number;
}

/** Same ramps as the tiles, so a scene reads as one drawing. */
export const OBJECT_DEFS: ObjectDef[] = [
  { type: "player", label: "Player", color: 0x416180, shape: "capsule", group: "player", data: { speed: 220, jump: 420 }, width: 28, height: 40 },
  { type: "coin", label: "Coin", color: 0x94bce3, shape: "star", group: "pickup", data: { value: 10 }, width: 24, height: 24 },
  { type: "enemy", label: "Enemy", color: 0xa6595e, shape: "triangle", group: "enemy", data: { patrolRange: 80, speed: 60 }, width: 28, height: 36 },
  { type: "spawn", label: "Spawn Point", color: 0x7e9cb8, shape: "diamond", group: "trigger", data: {}, width: 24, height: 24 },
  { type: "crate", label: "Crate", color: 0x7a7a7d, shape: "circle", group: "solid", data: { mass: 1 }, width: 32, height: 32 },
  { type: "exit", label: "Exit Zone", color: 0x2c455d, shape: "diamond", group: "trigger", data: { nextScene: "" }, width: 40, height: 56 },
];

/** Collision groups a fresh project knows about. */
export const DEFAULT_GROUPS = ["player", "enemy", "pickup", "solid", "trigger"];

export const BUILTIN_TILESET_ID = "tileset-placeholder";
export const BUILTIN_TILESET_KEY = "placeholder-tiles";
export const TILE_SIZE = 32;

export function objectDef(type: string): ObjectDef | undefined {
  return OBJECT_DEFS.find((d) => d.type === type);
}

export function objectTextureKey(type: string): string {
  return `obj-${type}`;
}

export function tileDef(index: number): TileDef | undefined {
  return TILE_DEFS.find((t) => t.index === index);
}
