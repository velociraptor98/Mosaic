/**
 * Snapping targets are the tile grid PLUS the edges of nearby objects. The
 * threshold is expressed in screen pixels and divided by the camera zoom, so
 * it feels the same at any magnification.
 */

export interface SnapCandidates {
  /** World-space x values worth snapping to (grid lines + object edges). */
  xs: number[];
  ys: number[];
  grid: number;
  /** Screen-space tolerance, in px. */
  threshold: number;
  zoom: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guideX: number | null;
  guideY: number | null;
}

export function snapPoint(x: number, y: number, c: SnapCandidates): SnapResult {
  const tol = c.threshold / (c.zoom || 1);
  let bestX = x;
  let guideX: number | null = null;
  let bestXDist = tol;

  const gridX = Math.round(x / c.grid) * c.grid;
  if (Math.abs(gridX - x) <= bestXDist) {
    bestX = gridX;
    bestXDist = Math.abs(gridX - x);
    guideX = gridX;
  }
  for (const candidate of c.xs) {
    const d = Math.abs(candidate - x);
    if (d < bestXDist) {
      bestXDist = d;
      bestX = candidate;
      guideX = candidate;
    }
  }

  let bestY = y;
  let guideY: number | null = null;
  let bestYDist = tol;
  const gridY = Math.round(y / c.grid) * c.grid;
  if (Math.abs(gridY - y) <= bestYDist) {
    bestY = gridY;
    bestYDist = Math.abs(gridY - y);
    guideY = gridY;
  }
  for (const candidate of c.ys) {
    const d = Math.abs(candidate - y);
    if (d < bestYDist) {
      bestYDist = d;
      bestY = candidate;
      guideY = candidate;
    }
  }

  return { x: bestX, y: bestY, guideX, guideY };
}

export function edgeCandidates(
  boxes: { left: number; right: number; centerX: number; top: number; bottom: number; centerY: number }[],
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of boxes) {
    xs.push(b.left, b.centerX, b.right);
    ys.push(b.top, b.centerY, b.bottom);
  }
  return { xs, ys };
}
