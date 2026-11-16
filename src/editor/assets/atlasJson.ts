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
 * So the document that shipped with the art is read instead. Every shape
 * Phaser itself loads is handled — the three JSON ones `load.atlas` takes and
 * the Starling XML `load.atlasXML` takes — because which one you get is decided
 * by whichever packer produced the file and not by the person importing it.
 * Kenney's packs, for one, ship XML.
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
  if (text.trimStart().startsWith("<")) return parseStarlingXml(text);
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

/**
 * Starling / Sparrow XML, which Phaser loads with `load.atlasXML`:
 *
 *   <TextureAtlas imagePath="sheet.png">
 *     <SubTexture name="blue1" x="0" y="0" width="32" height="32"/>
 *   </TextureAtlas>
 *
 * Read with a pattern rather than a DOM parser so the same function runs in the
 * renderer and in node. The format is one flat list of self-describing tags,
 * which is what makes that safe.
 */
function parseStarlingXml(text: string): AssetFrame[] | null {
  if (!/<TextureAtlas[\s>]/.test(text)) return null;
  const frames: AssetFrame[] = [];
  for (const tag of text.match(/<SubTexture\b[^>]*>/g) ?? []) {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[key] = value;
    const num = (key: string) => Number(attrs[key]);
    if (!attrs.name || ![num("x"), num("y"), num("width"), num("height")].every(Number.isFinite)) continue;
    frames.push({
      name: attrs.name,
      x: num("x"),
      y: num("y"),
      w: num("width"),
      h: num("height"),
      // Starling writes the pivot in pixels, when it writes one at all.
      pivotX: Number.isFinite(num("pivotX")) && num("width") ? num("pivotX") / num("width") : 0.5,
      pivotY: Number.isFinite(num("pivotY")) && num("height") ? num("pivotY") / num("height") : 0.5,
    });
  }
  return frames;
}

/** Documents that may describe the atlas an image is, e.g. beside "assets/kit.png". */
export const ATLAS_DOC_EXT = /\.(json|xml)$/i;

/** The atlas documents that would sit beside an image, in the order they are tried. */
export function atlasSidecarPaths(imagePath: string): string[] {
  return [".json", ".xml"].map((ext) => imagePath.replace(/\.\w+$/, ext));
}
