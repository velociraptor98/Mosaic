import { shapeDef } from "./definitions";
import type { BodyDef, ProjectData } from "./types";

/**
 * How big a thing is drawn.
 *
 * This used to be answered by an object's `type`, which meant only the six
 * built-in game roles had an answer and anything else got 32×32. Size is a
 * property of the ART, so it is read from the texture — a frame in an atlas, a
 * spritesheet cell, or the whole image — and only falls back to the body when
 * there is no art at all.
 */

/** The fields anything drawable has, whether it is a scene object or a prefab node. */
export interface Sized {
  type?: string;
  texture?: string;
  frame?: string;
  body?: BodyDef;
}

export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_SIZE: Size = { width: 32, height: 32 };

export function objectSize(project: Pick<ProjectData, "assets">, obj: Sized): Size {
  const asset = obj.texture ? project.assets.find((a) => a.key === obj.texture) : undefined;
  if (asset) {
    if (obj.frame && asset.frames?.length) {
      const frame = asset.frames.find((f) => f.name === obj.frame);
      if (frame) return { width: frame.w, height: frame.h };
    }
    if (asset.frameWidth && asset.frameHeight) {
      return { width: asset.frameWidth, height: asset.frameHeight };
    }
    if (asset.width && asset.height) return { width: asset.width, height: asset.height };
  }

  // A generated placeholder knows its own size even before Phaser has drawn it.
  const shape = obj.texture?.startsWith("shape-") ? shapeDef(obj.texture.slice(6)) : undefined;
  if (shape) return { width: shape.width, height: shape.height };

  if (obj.body) {
    return obj.body.shape === "circle"
      ? { width: obj.body.radius * 2, height: obj.body.radius * 2 }
      : { width: obj.body.width, height: obj.body.height };
  }
  return DEFAULT_SIZE;
}

/**
 * A body that matches the art, which is the only default that is right more
 * often than it is wrong. Everything else about it is the author's to set.
 */
export function bodyForSize(size: Size, patch: Partial<BodyDef> = {}): BodyDef {
  return {
    shape: "box",
    width: size.width,
    height: size.height,
    radius: Math.min(size.width, size.height) / 2,
    offsetX: 0,
    offsetY: 0,
    immovable: false,
    allowGravity: true,
    bounce: 0,
    ...patch,
  };
}
