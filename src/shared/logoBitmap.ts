import { SET_TILES, TILE, VIEWBOX, openTilesFor } from "./logoGeometry";

/**
 * The Mosaic mark, rasterised.
 *
 * The app icon is drawn from the same geometry the UI draws — there is no
 * bitmap checked into the repo to fall out of step with the mark. Axis-aligned
 * rectangles are all this needs, so coverage is computed exactly (a pixel takes
 * the fraction of itself a rectangle covers) rather than by supersampling:
 * shorter, and the edges land where the maths says they do.
 *
 * No DOM and no Node: the main process rasterises with it, the headless suite
 * asserts pixels from it.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

export type Rgb = readonly [number, number, number];

/** The identity sheet's one permitted filled field, and the mark reversed on it. */
export const FIELD: Rgb = [0x1d, 0x2d, 0x3d]; // --color-accent-900
export const REVERSED: Rgb = [0xf2, 0xf2, 0xf3]; // --color-bg
export const ACCENT: Rgb = [0x59, 0x80, 0xa6]; // --color-accent

/**
 * The mark occupies the middle 47% of the icon, which is the inset the
 * identity sheet's app-icon cut uses (a 242-unit mark on a 512-unit field).
 */
const MARK_FRACTION = 242 / 512;

export function mosaicIconBitmap(
  size: number,
  colors: { field: Rgb; mark: Rgb } = { field: FIELD, mark: REVERSED },
): Bitmap {
  const bitmap: Bitmap = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  fill(bitmap, colors.field);

  const scale = (size * MARK_FRACTION) / VIEWBOX;
  const origin = (size - VIEWBOX * scale) / 2;
  const at = (units: number) => origin + units * scale;

  for (const [x, y] of SET_TILES) {
    rect(bitmap, at(x), at(y), TILE * scale, TILE * scale, colors.mark);
  }

  // The two open tiles are outlines, and the ladder's stroke is centred on the
  // path the way SVG strokes it — so the band straddles the cell boundary.
  const open = openTilesFor(size);
  if (open) {
    for (const y of [open.inset, open.inset + 9]) {
      outline(bitmap, at(open.inset), at(y), open.span * scale, open.span * scale, open.stroke * scale, colors.mark);
    }
  }
  return bitmap;
}

function fill(bitmap: Bitmap, [r, g, b]: Rgb): void {
  for (let i = 0; i < bitmap.data.length; i += 4) {
    bitmap.data[i] = r;
    bitmap.data[i + 1] = g;
    bitmap.data[i + 2] = b;
    bitmap.data[i + 3] = 255;
  }
}

/** Antialiased axis-aligned rectangle: each pixel takes the area it covers. */
function rect(bitmap: Bitmap, x: number, y: number, w: number, h: number, color: Rgb): void {
  const x1 = x + w;
  const y1 = y + h;
  const left = Math.max(0, Math.floor(x));
  const right = Math.min(bitmap.width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y));
  const bottom = Math.min(bitmap.height, Math.ceil(y1));

  for (let py = top; py < bottom; py++) {
    const coverY = Math.min(y1, py + 1) - Math.max(y, py);
    if (coverY <= 0) continue;
    for (let px = left; px < right; px++) {
      const coverX = Math.min(x1, px + 1) - Math.max(x, px);
      if (coverX <= 0) continue;
      blend(bitmap, px, py, color, coverX * coverY);
    }
  }
}

/** Four bars, stroke-centred on the rectangle's edges. */
function outline(
  bitmap: Bitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: number,
  color: Rgb,
): void {
  const half = stroke / 2;
  rect(bitmap, x - half, y - half, w + stroke, stroke, color); // top
  rect(bitmap, x - half, y + h - half, w + stroke, stroke, color); // bottom
  rect(bitmap, x - half, y + half, stroke, h - stroke, color); // left
  rect(bitmap, x + w - half, y + half, stroke, h - stroke, color); // right
}

function blend(bitmap: Bitmap, px: number, py: number, [r, g, b]: Rgb, alpha: number): void {
  const i = (py * bitmap.width + px) * 4;
  const a = Math.min(1, Math.max(0, alpha));
  bitmap.data[i] = Math.round(bitmap.data[i] * (1 - a) + r * a);
  bitmap.data[i + 1] = Math.round(bitmap.data[i + 1] * (1 - a) + g * a);
  bitmap.data[i + 2] = Math.round(bitmap.data[i + 2] * (1 - a) + b * a);
  bitmap.data[i + 3] = 255;
}

/** The RGBA of one pixel, for tests and for sampling. */
export function pixelAt(bitmap: Bitmap, x: number, y: number): [number, number, number, number] {
  const i = (y * bitmap.width + x) * 4;
  return [bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2], bitmap.data[i + 3]];
}
