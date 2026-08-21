import type { Bitmap } from "./logoBitmap";

/**
 * A PNG writer with no dependencies and no canvas.
 *
 * `electron/png.ts` already does this with `node:zlib`, but the scaffold runs
 * in the renderer and the sample generator runs in Node, and placeholder art
 * has to come out identical in both. Deflate's STORED block type needs no
 * compressor at all — these images are a few kilobytes, so the bytes saved by
 * compressing them would not pay for a dependency.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const tag = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const payload = concat([tag, body]);
  return concat([u32(body.length), payload, u32(crc32(payload))]);
}

/** A zlib stream of STORED blocks — valid deflate, no compression. */
function storedZlib(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const MAX = 0xffff;
  for (let at = 0; at < raw.length || at === 0; at += MAX) {
    const slice = raw.subarray(at, Math.min(at + MAX, raw.length));
    const last = at + MAX >= raw.length ? 1 : 0;
    parts.push(
      new Uint8Array([last, slice.length & 255, (slice.length >> 8) & 255, ~slice.length & 255, (~slice.length >> 8) & 255]),
      slice,
    );
    if (last) break;
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

export function encodePng(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap;
  // Filter byte 0 (None) per scanline: honest, and free on art this flat.
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), at + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filter preset
  ihdr[12] = 0; // no interlace

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", storedZlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without Buffer or btoa, so this works wherever the editor runs. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function encodePngBase64(bitmap: Bitmap): string {
  return toBase64(encodePng(bitmap));
}

export function encodePngDataUrl(bitmap: Bitmap): string {
  return `data:image/png;base64,${encodePngBase64(bitmap)}`;
}
