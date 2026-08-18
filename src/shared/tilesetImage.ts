import { TILE_DEFS, TILE_SIZE } from "./definitions";

/**
 * Draws the placeholder tileset as a real PNG data: URL — one row of tiles,
 * exactly the layout Phaser's `addTilesetImage` expects.
 *
 * Deliberately free of any Phaser import so the project store (which needs a
 * starter tileset) does not drag the renderer in with it.
 */
/**
 * A wireframe hero sheet: 8 frames of a simple figure, so a new project has
 * something to animate before any art exists.
 */
export function placeholderHeroSheetDataUrl(frame = 32, frames = 8): string {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = frame * frames;
  canvas.height = frame;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  for (let i = 0; i < frames; i++) {
    const x = i * frame;
    const bob = Math.round(Math.sin((i / frames) * Math.PI * 2) * 2);
    ctx.strokeStyle = "#416180";
    ctx.fillStyle = "rgba(89,128,166,0.35)";
    ctx.lineWidth = 1;
    ctx.fillRect(x + 10.5, 6.5 + bob, 11, 19);
    ctx.strokeRect(x + 10.5, 6.5 + bob, 11, 19);
    ctx.beginPath();
    ctx.arc(x + 16, 9 + bob, 4, 0, Math.PI * 2);
    ctx.stroke();
    // legs alternate so the walk cycle reads at a glance
    const swing = i % 2 === 0 ? 3 : -3;
    ctx.beginPath();
    ctx.moveTo(x + 14, 25 + bob);
    ctx.lineTo(x + 14 - swing, 30);
    ctx.moveTo(x + 18, 25 + bob);
    ctx.lineTo(x + 18 + swing, 30);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

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
