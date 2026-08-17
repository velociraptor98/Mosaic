import { SET_TILES, openTilesFor } from "./logoGeometry";

/**
 * The Mosaic mark, per `Mosaic Logo.html`.
 *
 * A 3x3 grid on a 26-unit canvas: an 8-unit tile with a 1-unit gutter — the
 * canvas grid itself. Seven set tiles read as an M; the two open tiles are the
 * cells not yet painted.
 *
 * The size ladder is part of the mark: the stroke on the two open tiles
 * thickens as it shrinks, and below 16px they fill solid. That solid cut is
 * the favicon and app-icon cut, and the one used in the menu strip.
 */

export type MarkTone = "accent" | "hover" | "reversed" | "ink" | "dim";

const TONE: Record<MarkTone, { fill: string; opacity?: number }> = {
  accent: { fill: "var(--color-accent)" },
  hover: { fill: "var(--color-accent-700)" },
  reversed: { fill: "var(--color-bg)" },
  ink: { fill: "var(--color-neutral-900)" },
  dim: { fill: "var(--color-accent)", opacity: 0.45 },
};

export function MosaicMark({
  size = 24,
  tone = "accent",
  title,
}: {
  size?: number;
  tone?: MarkTone;
  title?: string;
}) {
  const open = openTilesFor(size);
  const { fill, opacity } = TONE[tone];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ display: "block", flex: "none", opacity }}
    >
      <g fill={fill}>
        {SET_TILES.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="8" height="8" />
        ))}
      </g>
      {open && (
        <g fill="none" stroke={fill} strokeWidth={open.stroke}>
          <rect x={open.inset} y={open.inset} width={open.span} height={open.span} />
          <rect x={open.inset} y={open.inset + 9} width={open.span} height={open.span} />
        </g>
      )}
    </svg>
  );
}

/**
 * The primary lockup: mark left, wordmark right, baselines aligned to the
 * mark's bottom tile row. Barlow Condensed 700 at 0.2em tracking.
 */
export function MosaicLockup({
  size = 24,
  tone = "accent",
  descriptor = false,
}: {
  size?: number;
  tone?: MarkTone;
  descriptor?: boolean;
}) {
  return (
    <div className="lockup">
      <MosaicMark size={size} tone={tone} title="Mosaic" />
      <div className="lockup-type">
        <span className="wordmark" style={{ fontSize: size * 0.79 }}>
          MOSAIC
        </span>
        {descriptor && <span className="descriptor">SCENE EDITOR FOR PHASER</span>}
      </div>
    </div>
  );
}
