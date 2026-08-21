import Phaser from "phaser";
import { SHAPE_STROKE, shapePolygon } from "./shapeGeometry";
import {
  BUILTIN_TILESET_KEY,
  SHAPE_DEFS,
  TILE_DEFS,
  TILE_SIZE,
  shapeTextureKey,
  type ObjectShape,
} from "./definitions";

/**
 * Generates the placeholder art both the editor and the runtime rely on:
 *
 *  - one real tileset *image* (tiles laid out left-to-right in a strip) so
 *    Phaser's native Tilemap API can be used unmodified, and
 *  - one texture per placeholder SHAPE.
 *
 * Safe to call repeatedly — existing keys are skipped.
 */
export function ensurePlaceholderTextures(scene: Phaser.Scene): void {
  ensurePlaceholderTileset(scene);

  const gfx = scene.make.graphics({ x: 0, y: 0 }, false);
  for (const def of SHAPE_DEFS) {
    const key = shapeTextureKey(def.shape);
    if (scene.textures.exists(key)) continue;
    gfx.clear();
    drawObjectShape(gfx, def.shape, def.color, def.width, def.height);
    gfx.generateTexture(key, def.width, def.height);
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
  gfx.fillStyle(color, 1);
  gfx.lineStyle(SHAPE_STROKE.width, SHAPE_STROKE.color, SHAPE_STROKE.alpha);

  // Geometry comes from shapeGeometry.ts, which the PNG rasteriser also reads.
  // Describing a star in two places is how the editor and the shipped art
  // drift apart.
  const points = shapePolygon(shape, w, h).map((p) => new Phaser.Math.Vector2(p.x, p.y));
  gfx.fillPoints(points, true);
  gfx.strokePoints(points, true);
}
