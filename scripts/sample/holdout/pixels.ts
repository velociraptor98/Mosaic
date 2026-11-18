import { deflateSync } from "node:zlib";

/**
 * Just enough of a paint program to draw Holdout's pixel art in code: a
 * canvas of RGBA pixels, the shapes 16-bit sprites are built from, an outline
 * pass, a PNG writer and an atlas packer.
 *
 * Everything is drawn at its native size, then written out at `scale` times
 * with nearest-neighbour, so the game keeps its 64px grid while every art
 * pixel is a 4 × 4 block.
 */

export type Color = string;

/** `#rrggbb` or `#rrggbbaa` → packed RGBA. */
function parse(color: Color): number {
  const hex = color.slice(1);
  const rgb = parseInt(hex.slice(0, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6), 16) : 255;
  return ((rgb << 8) | a) >>> 0;
}

/** Same seed, same picture: the sample is rebuilt byte for byte. */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** The 4 × 4 Bayer matrix, for ordered dithering between two colours. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const dither = (x: number, y: number, amount: number) => BAYER[(y & 3) * 4 + (x & 3)] / 16 < amount;

export class Pixels {
  readonly data: Uint32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint32Array(width * height);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Packed RGBA, 0 when empty or off the canvas. */
  get(x: number, y: number): number {
    return this.inside(x, y) ? this.data[y * this.width + x] : 0;
  }

  opaque(x: number, y: number): boolean {
    return (this.get(x, y) & 0xff) > 0;
  }

  set(x: number, y: number, color: Color): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (this.inside(x, y)) this.data[y * this.width + x] = parse(color);
  }

  clear(x: number, y: number): void {
    if (this.inside(x, y)) this.data[y * this.width + x] = 0;
  }

  fill(color: Color): this {
    this.data.fill(parse(color));
    return this;
  }

  rect(x: number, y: number, w: number, h: number, color: Color): this {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, color);
    return this;
  }

  /** Every pixel whose centre is inside, coloured by `paint`. */
  each(test: (x: number, y: number) => boolean, paint: (x: number, y: number) => Color | null): this {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!test(x + 0.5, y + 0.5)) continue;
        const c = paint(x, y);
        if (c) this.set(x, y, c);
      }
    }
    return this;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: Color): this {
    return this.each((x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, () => color);
  }

  /**
   * A lit ball: `ramp` runs dark → light, and the light comes from the top
   * left, as it does across every sprite in the game.
   */
  ball(cx: number, cy: number, rx: number, ry: number, ramp: Color[]): this {
    return this.each(
      (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1,
      (x, y) => ramp[lightAt((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry, ramp.length)],
    );
  }

  /** A line `thickness` pixels wide, centre to centre. */
  line(x0: number, y0: number, x1: number, y1: number, color: Color, thickness = 1): this {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    const r = thickness / 2;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      if (thickness <= 1) this.set(x, y, color);
      else this.rect(Math.round(x - r), Math.round(y - r), thickness, thickness, color);
    }
    return this;
  }

  /** A 1px border on the outside of everything drawn so far. */
  outline(color: Color): this {
    const add: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.opaque(x, y)) continue;
        if (this.opaque(x - 1, y) || this.opaque(x + 1, y) || this.opaque(x, y - 1) || this.opaque(x, y + 1)) {
          add.push(x, y);
        }
      }
    }
    for (let i = 0; i < add.length; i += 2) this.set(add[i], add[i + 1], color);
    return this;
  }

  /** Another canvas on top of this one, its empty pixels left out. */
  stamp(other: Pixels, dx: number, dy: number): this {
    for (let y = 0; y < other.height; y++) {
      for (let x = 0; x < other.width; x++) {
        const c = other.get(x, y);
        if (c & 0xff && this.inside(dx + x, dy + y)) this.data[(dy + y) * this.width + dx + x] = c;
      }
    }
    return this;
  }

  /** Written as a PNG, each pixel `scale` × `scale`. */
  png(scale = 1): Buffer {
    return encodePng(this, scale);
  }
}

/** 0 (shadow) … levels-1 (highlight) for a point on a unit ball. */
export function lightAt(nx: number, ny: number, levels: number): number {
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  // Light from the top left and a little in front.
  const lit = -0.55 * nx - 0.6 * ny + 0.58 * nz;
  const t = Math.min(0.999, Math.max(0, (lit + 0.35) / 1.25));
  return Math.floor(t * levels);
}

// ------------------------------------------------------------------ PNG

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(pixels: Pixels, scale: number): Buffer {
  const w = pixels.width * scale;
  const h = pixels.height * scale;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw.writeUInt32BE(pixels.get(Math.floor(x / scale), Math.floor(y / scale)), row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- atlas

/**
 * Frames packed onto one sheet, with the Starling XML a packer such as
 * TexturePacker writes beside it — the same pair an artist would hand over.
 */
export function packAtlas(
  imagePath: string,
  frames: { name: string; pixels: Pixels }[],
  scale: number,
  maxWidth = 96,
): { png: Buffer; xml: string } {
  const pad = 1;
  const placed: { name: string; pixels: Pixels; x: number; y: number }[] = [];
  let x = pad;
  let y = pad;
  let shelf = 0;
  let width = 0;
  for (const frame of frames) {
    if (x + frame.pixels.width + pad > maxWidth) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    placed.push({ ...frame, x, y });
    x += frame.pixels.width + pad;
    shelf = Math.max(shelf, frame.pixels.height);
    width = Math.max(width, x);
  }
  const sheet = new Pixels(width, y + shelf + pad);
  for (const p of placed) sheet.stamp(p.pixels, p.x, p.y);

  const lines = placed.map(
    (p) =>
      `  <SubTexture name="${p.name}" x="${p.x * scale}" y="${p.y * scale}" width="${p.pixels.width * scale}" height="${p.pixels.height * scale}"/>`,
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<TextureAtlas imagePath="${imagePath}">\n${lines.join("\n")}\n</TextureAtlas>\n`;
  return { png: sheet.png(scale), xml };
}
