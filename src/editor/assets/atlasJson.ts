import type { AssetFrame } from "../../shared/types";

/**
 * Reading an atlas that already exists.
 *
 * Mosaic could always MAKE an atlas — slice an image by grid, or flood-fill
 * islands of opaque pixels — but it named what it found from a pattern
 * (`frame_0`, `frame_1`, …). That is fine for a sheet you are cutting up for
 * the first time and useless for art that arrives already packed, because the
 * names are the part that matters: a scene says `texture: "assets", frame:
 * "blue1"`, and `frame_7` is not that.
 *
 * So the JSON that shipped with the art is read instead. All three shapes
 * Phaser itself accepts are handled, because which one you get is decided by
 * whichever packer produced the file and not by the person importing it.
 */

interface RawFrame {
  filename?: string;
  name?: string;
  frame?: { x: number; y: number; w: number; h: number };
  pivot?: { x: number; y: number };
}

/**
 * Frames from a Phaser atlas document, or null when this is not one.
 *
 * Null rather than an empty list on purpose: "not an atlas" and "an atlas with
 * nothing in it" are different answers, and only the second is worth an error.
 */
export function parsePhaserAtlas(text: string): AssetFrame[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const raw = framesOf(doc as Record<string, unknown>);
  if (!raw) return null;

  const frames: AssetFrame[] = [];
  for (const [name, entry] of raw) {
    const box = entry.frame;
    // A frame without a rectangle cannot be drawn, so it is not a frame.
    if (!box || typeof box.x !== "number" || typeof box.w !== "number") continue;
    frames.push({
      name,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // Packers write the pivot in the frame's own 0..1 space, which is the
      // same space Mosaic stores it in. Centre when the file does not say.
      pivotX: typeof entry.pivot?.x === "number" ? entry.pivot.x : 0.5,
      pivotY: typeof entry.pivot?.y === "number" ? entry.pivot.y : 0.5,
    });
  }
  return frames;
}

/**
 * The three shapes, as [name, frame] pairs:
 *
 *   JSON Hash    { frames: { "blue1": {...} } }
 *   JSON Array   { frames: [ { filename: "blue1", ... } ] }
 *   Multi-atlas  { textures: [ { frames: [ ... ] } ] }
 */
function framesOf(doc: Record<string, unknown>): [string, RawFrame][] | null {
  const textures = doc.textures;
  if (Array.isArray(textures) && textures.length) {
    const first = textures[0] as { frames?: unknown };
    if (Array.isArray(first?.frames)) return fromArray(first.frames as RawFrame[]);
  }

  const frames = doc.frames;
  if (Array.isArray(frames)) return fromArray(frames as RawFrame[]);
  if (frames && typeof frames === "object") {
    return Object.entries(frames as Record<string, RawFrame>).map(
      ([name, entry]) => [name, entry] as [string, RawFrame],
    );
  }
  return null;
}

function fromArray(list: RawFrame[]): [string, RawFrame][] {
  return list.map((entry, i) => [entry.filename ?? entry.name ?? `frame_${i}`, entry]);
}

/** The atlas document that would sit beside an image, e.g. "assets/kit.png". */
export function atlasSidecarPath(imagePath: string): string {
  return imagePath.replace(/\.\w+$/, ".json");
}
