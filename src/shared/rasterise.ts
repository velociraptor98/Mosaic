import { SHAPE_DEFS, TILE_DEFS, TILE_SIZE, shapeTextureKey } from "./definitions";
import type { Bitmap } from "./logoBitmap";
import { SHAPE_STROKE, shapePolygon, type Point } from "./shapeGeometry";

/**
 * Placeholder art as real pixels, with no canvas involved.
 *
 * The editor could always draw these — it has Phaser and a DOM. A PROJECT
 * could not: the exporter emitted `load.image("shape-star", …)` for files that
 * were never written, so an exported game loaded five missing textures and
 * rendered nothing at all. It compiled, it bundled, and it was blank.
 *
 * Being canvas-free is what lets the same bytes be written from the editor, a
 * build script or a test, and the geometry comes from `shapeGeometry.ts` so
 * the PNG and the editor's own drawing cannot disagree about what a star is.
 */

/** 3× supersampling: enough to keep a star's points from looking chewed. */
const SS = 3;

function blank(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Even-odd fill test against a closed polygon. */
function inside(points: Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Shortest distance from a point to the polygon's outline. */
function edgeDistance(points: Point[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

function rgb(color: number): [number, number, number] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

export interface Painted {
  points: Point[];
  color: number;
  /** Outlined as well as filled. Off for interior detail like a leg. */
  outline?: boolean;
}

/**
 * Composites one polygon into a bitmap at an x offset.
 *
 * Coverage is sampled on an SS×SS grid per pixel, which is what keeps a
 * triangle's diagonal from stepping and a star's points from looking chewed.
 * Later shapes paint over earlier ones, so a frame is a list back to front.
 */
export function fillPolygon(bmp: Bitmap, shape: Painted, ox = 0): void {
  const { points, color } = shape;
  const [fr, fg, fb] = rgb(color);
  const [sr, sg, sb] = rgb(SHAPE_STROKE.color);
  const half = SHAPE_STROKE.width / 2;
  const step = 1 / SS;
  const offset = step / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX - 2));
  const x1 = Math.min(bmp.width - ox, Math.ceil(maxX + 2));
  const y0 = Math.max(0, Math.floor(minY - 2));
  const y1 = Math.min(bmp.height, Math.ceil(maxY + 2));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let fill = 0;
      let stroke = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + sx * step + offset;
          const py = y + sy * step + offset;
          const on = inside(points, px, py);
          if (shape.outline !== false && edgeDistance(points, px, py) <= half) stroke += 1;
          else if (on) fill += 1;
        }
      }
      const total = SS * SS;
      const strokeA = (stroke / total) * SHAPE_STROKE.alpha;
      const fillA = fill / total;
      const alpha = Math.min(1, strokeA + fillA);
      if (alpha <= 0) continue;

      const weight = strokeA + fillA;
      const at = (y * bmp.width + (x + ox)) * 4;
      const r = Math.round((sr * strokeA + fr * fillA) / weight);
      const g = Math.round((sg * strokeA + fg * fillA) / weight);
      const b = Math.round((sb * strokeA + fb * fillA) / weight);
      // Source-over against whatever is already there.
      const dstA = bmp.data[at + 3] / 255;
      const outA = alpha + dstA * (1 - alpha);
      bmp.data[at] = Math.round((r * alpha + bmp.data[at] * dstA * (1 - alpha)) / outA);
      bmp.data[at + 1] = Math.round((g * alpha + bmp.data[at + 1] * dstA * (1 - alpha)) / outA);
      bmp.data[at + 2] = Math.round((b * alpha + bmp.data[at + 2] * dstA * (1 - alpha)) / outA);
      bmp.data[at + 3] = Math.round(outA * 255);
    }
  }
}

/** One filled, outlined shape, on its own transparent bitmap. */
export function rasteriseShape(
  shape: (typeof SHAPE_DEFS)[number]["shape"],
  color: number,
  width: number,
  height: number,
): Bitmap {
  const bmp = blank(width, height);
  fillPolygon(bmp, { points: shapePolygon(shape, width, height), color });
  return bmp;
}

/**
 * A strip of frames, left to right — the layout Phaser's spritesheet loader
 * expects, so `frameWidth` / `frameHeight` are all it needs to cut them.
 */
export function rasteriseStrip(
  frames: Painted[][],
  frameWidth: number,
  frameHeight: number,
): Bitmap {
  const bmp = blank(frameWidth * frames.length, frameHeight);
  frames.forEach((shapes, i) => {
    for (const shape of shapes) fillPolygon(bmp, shape, i * frameWidth);
  });
  return bmp;
}

/**
 * The placeholder tileset: one row of tiles, exactly the layout
 * `addTilesetImage` expects.
 */
export function rasteriseTileset(): Bitmap {
  const width = TILE_DEFS.length * TILE_SIZE;
  const bmp = blank(width, TILE_SIZE);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const at = (y * width + x) * 4;
    bmp.data[at] = r;
    bmp.data[at + 1] = g;
    bmp.data[at + 2] = b;
    bmp.data[at + 3] = a;
  };

  TILE_DEFS.forEach((tile, i) => {
    const ox = i * TILE_SIZE;
    const [r, g, b] = rgb(tile.color);
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) put(ox + x, y, r, g, b, 255);
    }
    // A hint of texture, so painted terrain reads as terrain rather than as
    // flat colour — the same highlight the editor draws.
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < TILE_SIZE - 3; x++) {
        put(ox + x, y, Math.min(255, r + 46), Math.min(255, g + 46), Math.min(255, b + 46), 255);
      }
    }
    // One-pixel border, so tile boundaries are visible on a painted run.
    for (let x = 0; x < TILE_SIZE; x++) {
      put(ox + x, 0, 29, 31, 32, 46);
      put(ox + x, TILE_SIZE - 1, 29, 31, 32, 46);
    }
    for (let y = 0; y < TILE_SIZE; y++) {
      put(ox, y, 29, 31, 32, 46);
      put(ox + TILE_SIZE - 1, y, 29, 31, 32, 46);
    }
  });
  return bmp;
}

export interface PlaceholderImage {
  /** Project-relative path, matching what the manifest declares. */
  path: string;
  bitmap: Bitmap;
}

/**
 * Every placeholder a project references. The paths are the manifest's own, so
 * what the exporter emits a `load.image` for is what exists on disk.
 */
export function placeholderImages(): PlaceholderImage[] {
  return [
    { path: "assets/placeholder-tiles.png", bitmap: rasteriseTileset() },
    ...SHAPE_DEFS.map((def) => ({
      path: `assets/${shapeTextureKey(def.shape)}.png`,
      bitmap: rasteriseShape(def.shape, def.color, def.width, def.height),
    })),
  ];
}
