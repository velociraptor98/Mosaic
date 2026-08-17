import type { AssetFrame, AssetKind } from "../../shared/types";

/**
 * Atlas slicing. Grid slicing with margin/spacing covers sheets exported by
 * every tool worth naming; auto-detect handles the ones packed by hand.
 */

export interface GridOptions {
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
}

export function sliceGrid(
  imageWidth: number,
  imageHeight: number,
  opts: GridOptions,
): Omit<AssetFrame, "name">[] {
  const frames: Omit<AssetFrame, "name">[] = [];
  const { frameWidth: fw, frameHeight: fh, margin, spacing } = opts;
  if (fw <= 0 || fh <= 0) return frames;
  for (let y = margin; y + fh <= imageHeight; y += fh + spacing) {
    for (let x = margin; x + fw <= imageWidth; x += fw + spacing) {
      frames.push({ x, y, w: fw, h: fh, pivotX: 0.5, pivotY: 0.5 });
    }
  }
  return frames;
}

/**
 * Flood-fills islands of non-transparent pixels and returns their bounding
 * boxes, left-to-right then top-to-bottom.
 */
export function autoDetectFrames(
  data: ImageData,
  alphaThreshold = 8,
): Omit<AssetFrame, "name">[] {
  const { width, height } = data;
  const seen = new Uint8Array(width * height);
  const boxes: Omit<AssetFrame, "name">[] = [];
  const stack: number[] = [];

  const solid = (i: number) => data.data[i * 4 + 3] > alphaThreshold;

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !solid(start)) continue;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || !solid(n)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < 2 || h < 2) continue; // stray pixels are not frames
    boxes.push({ x: minX, y: minY, w, h, pivotX: 0.5, pivotY: 0.5 });
  }

  boxes.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  return boxes;
}

/** "hero_{i}" -> hero_0, hero_1, ... A pattern beats renaming 32 frames. */
export function nameFrames(
  frames: Omit<AssetFrame, "name">[],
  pattern: string,
  startIndex = 0,
  pad = 0,
): AssetFrame[] {
  return frames.map((frame, i) => {
    const n = String(i + startIndex).padStart(pad, "0");
    const name = pattern.includes("{i}") ? pattern.replace(/\{i\}/g, n) : `${pattern}${n}`;
    return { ...frame, name };
  });
}

export function inferAssetKind(file: File): AssetKind {
  const name = file.name.toLowerCase();
  if (/\.(mp3|ogg|wav|m4a)$/.test(name)) return "audio";
  if (/tile(set|s)?[-_.]/.test(name) || /[-_.]tiles?\./.test(name)) return "tileset";
  if (/(sheet|sprites?|atlas|anim)/.test(name)) return "spritesheet";
  return "image";
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

export function imageDataOf(url: string): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
