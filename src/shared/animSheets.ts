import type { Bitmap } from "./logoBitmap";
import { rasteriseStrip, type Painted } from "./rasterise";
import type { Point } from "./shapeGeometry";

/**
 * Placeholder sprite sheets: a walk cycle and a spin cycle.
 *
 * A project needs something with FRAMES before the animation timeline has
 * anything to put on it, and drawing them here — canvas-free, from the same
 * rasteriser the placeholder shapes use — means the editor, a build script and
 * a test all produce identical bytes.
 *
 * Both are laid out as a single row, which is what `frameWidth` / `frameHeight`
 * is enough to cut.
 */

const INK = 0x416180;
const LIMB = 0x2c455d;
const GOLD = 0x94bce3;

function ellipse(cx: number, cy: number, rx: number, ry: number, steps = 28): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export const HERO_FRAME = { width: 32, height: 40, frames: 8 };

/**
 * Eight frames of a figure walking: the body bobs on a sine, the legs swing
 * out of phase. Frames 0 and 4 are the two contact poses, which is why an
 * idle animation can be built from just those two.
 */
export function heroWalkSheet(): Bitmap {
  const { width: w, height: h, frames } = HERO_FRAME;
  const strip: Painted[][] = [];

  for (let i = 0; i < frames; i++) {
    const phase = (i / frames) * Math.PI * 2;
    const bob = Math.round(Math.sin(phase * 2) * 1.5);
    const swing = Math.sin(phase) * 5;
    const cx = w / 2;
    const hipY = h - 14 + bob;

    strip.push([
      // legs first, so the body paints over the hips
      { points: rect(cx - 5 + swing, hipY, 4, 12), color: LIMB, outline: false },
      { points: rect(cx + 1 - swing, hipY, 4, 12), color: LIMB, outline: false },
      { points: rect(cx - 6, 12 + bob, 12, 16), color: INK },
      { points: ellipse(cx, 9 + bob, 5, 5), color: INK },
    ]);
  }
  return rasteriseStrip(strip, w, h);
}

export const SPIN_FRAME = { width: 24, height: 24, frames: 8 };

/**
 * A coin turning on its axis: the ellipse narrows to an edge and opens out
 * again. Frame 2 is the thin edge, which makes it a useful last frame for a
 * one-shot "vanish".
 */
export function coinSpinSheet(): Bitmap {
  const { width: w, height: h, frames } = SPIN_FRAME;
  const strip: Painted[][] = [];

  for (let i = 0; i < frames; i++) {
    const rx = Math.max(1.5, Math.abs(Math.cos((i / frames) * Math.PI * 2)) * 9);
    strip.push([
      { points: ellipse(w / 2, h / 2, rx, 9), color: GOLD },
      // A slim inner face, so the turn reads even at the widest frame.
      ...(rx > 4
        ? [{ points: ellipse(w / 2, h / 2, rx - 3, 6), color: INK, outline: false } as Painted]
        : []),
    ]);
  }
  return rasteriseStrip(strip, w, h);
}

export interface SheetSpec {
  key: string;
  path: string;
  frameWidth: number;
  frameHeight: number;
  bitmap: Bitmap;
}

/** The sheets a project ships, with the metadata the manifest needs. */
export function animationSheets(): SheetSpec[] {
  return [
    {
      key: "hero_sheet",
      path: "assets/hero_sheet.png",
      frameWidth: HERO_FRAME.width,
      frameHeight: HERO_FRAME.height,
      bitmap: heroWalkSheet(),
    },
    {
      key: "coin_sheet",
      path: "assets/coin_sheet.png",
      frameWidth: SPIN_FRAME.width,
      frameHeight: SPIN_FRAME.height,
      bitmap: coinSpinSheet(),
    },
  ];
}
