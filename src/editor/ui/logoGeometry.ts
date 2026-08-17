/**
 * Mosaic mark geometry, from `Mosaic Logo.html`.
 *
 * A 3x3 grid on a 26-unit canvas: an 8-unit tile with a 1-unit gutter — the
 * canvas grid itself. Seven set tiles read as an M; the two open tiles are the
 * cells not yet painted.
 *
 * Kept free of JSX so the geometry can be asserted headlessly.
 */

/** Top-left corners of the seven set tiles. */
export const SET_TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 9],
  [0, 18],
  [9, 0],
  [18, 0],
  [18, 9],
  [18, 18],
];

export const TILE = 8;
export const VIEWBOX = 26;

export interface OpenTiles {
  inset: number;
  span: number;
  stroke: number;
}

/**
 * The size ladder is part of the mark: "stroke on the two open tiles thickens
 * as the mark shrinks; below 16px they fill solid — that is the favicon and
 * app-icon cut".
 *
 * The three steps below are the sheet's own ladder samples (52 / 32 / 20).
 * Note the sheet is not self-consistent about sizes between those samples —
 * its nav lockup (26px) and applied editor header (24px) both draw stroke 1,
 * while its "states in product" row draws 24px solid. The ladder panel is the
 * one that exists to define this, so it wins here.
 */
export function openTilesFor(size: number): OpenTiles | null {
  if (size < 16) return null; // solid cut
  if (size >= 40) return { inset: 9.5, span: 7, stroke: 1 };
  if (size >= 26) return { inset: 9.6, span: 6.8, stroke: 1.2 };
  return { inset: 9.75, span: 6.5, stroke: 1.5 };
}
