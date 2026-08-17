import Phaser from "phaser";
import {
  BUILTIN_TILESET_KEY,
  OBJECT_DEFS,
  TILE_DEFS,
  TILE_SIZE,
  objectTextureKey,
  type ObjectShape,
} from "./definitions";

/**
 * Generates the placeholder art both the editor and the runtime rely on:
 *
 *  - one real tileset *image* (tiles laid out left-to-right in a strip) so
 *    Phaser's native Tilemap API can be used unmodified, and
 *  - one texture per built-in object type.
 *
 * Safe to call repeatedly — existing keys are skipped.
 */
export function ensurePlaceholderTextures(scene: Phaser.Scene): void {
  ensurePlaceholderTileset(scene);

  const gfx = scene.make.graphics({ x: 0, y: 0 }, false);
  for (const obj of OBJECT_DEFS) {
    const key = objectTextureKey(obj.type);
    if (scene.textures.exists(key)) continue;
    gfx.clear();
    drawObjectShape(gfx, obj.shape, obj.color, obj.width, obj.height);
    gfx.generateTexture(key, obj.width, obj.height);
  }
  gfx.destroy();
}

export function ensurePlaceholderTileset(scene: Phaser.Scene): void {
  if (scene.textures.exists(BUILTIN_TILESET_KEY)) return;
  const gfx = scene.make.graphics({ x: 0, y: 0 }, false);
  TILE_DEFS.forEach((tile, i) => {
    const x = i * TILE_SIZE;
    gfx.fillStyle(tile.color, 1);
    gfx.fillRect(x, 0, TILE_SIZE, TILE_SIZE);
    gfx.lineStyle(1, 0x1d1f20, 0.18);
    gfx.strokeRect(x + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
    // A hint of texture so painted terrain reads as terrain.
    gfx.fillStyle(0xffffff, 0.22);
    gfx.fillRect(x + 3, 3, TILE_SIZE - 6, 6);
  });
  gfx.generateTexture(BUILTIN_TILESET_KEY, TILE_DEFS.length * TILE_SIZE, TILE_SIZE);
  gfx.destroy();
}

function drawObjectShape(
  gfx: Phaser.GameObjects.Graphics,
  shape: ObjectShape,
  color: number,
  w: number,
  h: number,
): void {
  const cx = w / 2;
  const cy = h / 2;
  gfx.fillStyle(color, 1);
  gfx.lineStyle(1.5, 0x1d2d3d, 0.55);

  switch (shape) {
    case "circle": {
      const r = Math.min(cx, cy) - 2;
      gfx.fillCircle(cx, cy, r);
      gfx.strokeCircle(cx, cy, r);
      break;
    }
    case "capsule": {
      gfx.fillRoundedRect(2, 2, w - 4, h - 4, Math.min(w, h) / 3);
      gfx.strokeRoundedRect(2, 2, w - 4, h - 4, Math.min(w, h) / 3);
      break;
    }
    case "diamond": {
      const pts = [
        new Phaser.Math.Vector2(cx, 2),
        new Phaser.Math.Vector2(w - 2, cy),
        new Phaser.Math.Vector2(cx, h - 2),
        new Phaser.Math.Vector2(2, cy),
      ];
      gfx.fillPoints(pts, true);
      gfx.strokePoints(pts, true);
      break;
    }
    case "triangle": {
      const pts = [
        new Phaser.Math.Vector2(cx, 2),
        new Phaser.Math.Vector2(w - 2, h - 2),
        new Phaser.Math.Vector2(2, h - 2),
      ];
      gfx.fillPoints(pts, true);
      gfx.strokePoints(pts, true);
      break;
    }
    case "star": {
      const pts: Phaser.Math.Vector2[] = [];
      const spikes = 5;
      const outer = Math.min(cx, cy) - 2;
      const inner = outer * 0.45;
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = (Math.PI / spikes) * i - Math.PI / 2;
        pts.push(new Phaser.Math.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
      }
      gfx.fillPoints(pts, true);
      gfx.strokePoints(pts, true);
      break;
    }
  }
}
