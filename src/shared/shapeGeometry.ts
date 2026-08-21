import type { ObjectShape } from "./definitions";

/**
 * The placeholder shapes, as geometry — one definition, three consumers.
 *
 * Phaser draws these onto a canvas for the editor, and a canvas-free rasteriser
 * turns the same points into the PNG files a project ships. Describing a star
 * twice is how the two drift, so it is described once and both read from here.
 *
 * Every shape is an outline in the box (0,0)–(w,h). Curves are approximated
 * with enough segments to read as curves at placeholder sizes.
 */

export interface Point {
  x: number;
  y: number;
}

const INSET = 2;

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

export function shapePolygon(shape: ObjectShape, w: number, h: number): Point[] {
  const cx = w / 2;
  const cy = h / 2;
  const l = INSET;
  const t = INSET;
  const r = w - INSET;
  const b = h - INSET;

  switch (shape) {
    case "circle": {
      const rad = Math.min(cx, cy) - INSET;
      return arc(cx, cy, rad, rad, 0, Math.PI * 2, 48);
    }
    case "box":
      return [
        { x: l, y: t },
        { x: r, y: t },
        { x: r, y: b },
        { x: l, y: b },
      ];
    case "capsule": {
      // A rounded rectangle: four corner arcs joined in order.
      const rad = Math.min(w, h) / 3;
      return [
        ...arc(r - rad, t + rad, rad, rad, -Math.PI / 2, 0, 8),
        ...arc(r - rad, b - rad, rad, rad, 0, Math.PI / 2, 8),
        ...arc(l + rad, b - rad, rad, rad, Math.PI / 2, Math.PI, 8),
        ...arc(l + rad, t + rad, rad, rad, Math.PI, Math.PI * 1.5, 8),
      ];
    }
    case "diamond":
      return [
        { x: cx, y: t },
        { x: r, y: cy },
        { x: cx, y: b },
        { x: l, y: cy },
      ];
    case "triangle":
      return [
        { x: cx, y: t },
        { x: r, y: b },
        { x: l, y: b },
      ];
    case "star": {
      const spikes = 5;
      const outer = Math.min(cx, cy) - INSET;
      const inner = outer * 0.45;
      const out: Point[] = [];
      for (let i = 0; i < spikes * 2; i++) {
        const rad = i % 2 === 0 ? outer : inner;
        const a = (Math.PI / spikes) * i - Math.PI / 2;
        out.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
      }
      return out;
    }
  }
}

/** The outline every placeholder is stroked with, so the set reads as a set. */
export const SHAPE_STROKE = { color: 0x1d2d3d, alpha: 0.55, width: 1.5 };
