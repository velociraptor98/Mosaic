import { TILE_DEFS, TILE_SIZE } from "./definitions";

/**
 * Draws the placeholder tileset as a real PNG data: URL — one row of tiles,
 * exactly the layout Phaser's `addTilesetImage` expects.
 *
 * Deliberately free of any Phaser import so the project store (which needs a
 * starter tileset) does not drag the renderer in with it.
 */
export function placeholderTilesetDataUrl(): string {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = TILE_DEFS.length * TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  TILE_DEFS.forEach((tile, i) => {
    const x = i * TILE_SIZE;
    ctx.fillStyle = `#${tile.color.toString(16).padStart(6, "0")}`;
    ctx.fillRect(x, 0, TILE_SIZE, TILE_SIZE);
    ctx.strokeStyle = "rgba(29,31,32,0.18)";
    ctx.strokeRect(x + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(x + 3, 3, TILE_SIZE - 6, 6);
  });
  return canvas.toDataURL("image/png");
}
