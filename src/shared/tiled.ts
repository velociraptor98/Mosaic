import type { AssetDef, TilemapInfo } from "./types";

/**
 * Tiled maps, read the way Phaser reads them.
 *
 * Mosaic does not edit tiles. Terrain is authored in Tiled — which is what
 * Phaser developers already use, and what `load.tilemapTiledJSON` already
 * loads — and Mosaic places it: which map a scene uses, where each of its
 * layers sits in the draw order, and what stands on top of it.
 *
 * So this file only has to understand enough of a map to describe it and to
 * write a small one. Rendering is Phaser's own parser, in the editor's canvas
 * and in the game alike, which is what makes the two agree.
 */

/** The custom tile property that marks a tile solid. The Phaser convention. */
export const COLLIDES_PROPERTY = "collides";

/** Where Mosaic writes a map it creates. */
export const MAP_DIR = "assets/maps";
export const MAP_EXT = /\.(tmj|json)$/i;

interface TiledProperty {
  name: string;
  type?: string;
  value: unknown;
}

export interface TiledTileset {
  firstgid: number;
  name?: string;
  /** Set on an EXTERNAL tileset, which Phaser cannot load. */
  source?: string;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  margin?: number;
  spacing?: number;
  columns?: number;
  tilecount?: number;
  tiles?: { id: number; properties?: TiledProperty[] }[];
}

export interface TiledLayer {
  id?: number;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  data?: number[] | string;
  layers?: TiledLayer[];
}

export interface TiledMap {
  type?: string;
  version?: string | number;
  tiledversion?: string;
  orientation?: string;
  renderorder?: string;
  infinite?: boolean;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  nextlayerid?: number;
  nextobjectid?: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
}

/** True for JSON that is a Tiled map rather than, say, an atlas document. */
export function isTiledMap(value: unknown): value is TiledMap {
  const m = value as Partial<TiledMap> | null;
  return (
    !!m &&
    typeof m === "object" &&
    Array.isArray(m.layers) &&
    Array.isArray(m.tilesets) &&
    typeof m.tilewidth === "number" &&
    typeof m.tileheight === "number" &&
    typeof m.width === "number" &&
    typeof m.height === "number"
  );
}

export function parseTiledMap(text: string): TiledMap | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isTiledMap(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Tile layers bottom-up, group layers flattened — the order Phaser draws them. */
function tileLayers(layers: TiledLayer[], out: TiledLayer[] = []): TiledLayer[] {
  for (const layer of layers) {
    if (layer.type === "tilelayer") out.push(layer);
    else if (layer.type === "group" && layer.layers) tileLayers(layer.layers, out);
  }
  return out;
}

/** `assets/maps/../tiles.png` -> `assets/tiles.png`. */
function resolveRelative(fromFile: string, rel: string): string {
  const out = fromFile.split("/").slice(0, -1);
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * What the rest of Mosaic needs to know about a map: its size, its tile
 * layers by name, and which of the project's images each tileset draws with.
 *
 * A tileset's image is matched by the path the map states, then by file name.
 * The second is what makes a map copied into `assets/` beside its art still
 * resolve — the relative path it was authored with no longer points anywhere,
 * and the file name still says which image it meant.
 */
export function describeTiledMap(
  map: TiledMap,
  mapPath: string,
  assets: Pick<AssetDef, "key" | "path" | "kind">[],
): TilemapInfo {
  const issues: string[] = [];
  const images = assets.filter((a) => a.kind !== "audio" && a.kind !== "tilemap");

  const tilesets = map.tilesets.map((set, i) => {
    const name = set.name ?? `tileset ${i + 1}`;
    if (set.source || !set.image) {
      issues.push(
        `Tileset "${set.source ?? name}" is external. Phaser only loads tilesets embedded in the map — in Tiled, use "Embed Tileset" and export again.`,
      );
      return { name, image: null, imagePath: set.source ?? "" };
    }
    const wanted = resolveRelative(mapPath, set.image);
    const base = set.image.replace(/\\/g, "/").split("/").pop();
    const asset =
      images.find((a) => a.path === wanted) ?? images.find((a) => a.path.split("/").pop() === base);
    if (!asset) {
      issues.push(`Tileset "${name}" draws with ${set.image}, which is not in the project's assets.`);
    }
    return { name, image: asset?.key ?? null, imagePath: wanted };
  });

  if (map.orientation && map.orientation !== "orthogonal") {
    issues.push(`The map is ${map.orientation}; only orthogonal maps are laid out correctly here.`);
  }
  if (map.infinite) {
    issues.push(`The map is infinite. Phaser needs a fixed size — turn "Infinite" off in Map Properties.`);
  }

  const collides = map.tilesets.some((set) =>
    (set.tiles ?? []).some((tile) =>
      (tile.properties ?? []).some((p) => p.name === COLLIDES_PROPERTY && p.value === true),
    ),
  );

  return {
    tileWidth: map.tilewidth,
    tileHeight: map.tileheight,
    cols: map.width,
    rows: map.height,
    layers: tileLayers(map.layers).map((l) => l.name),
    tilesets,
    collides,
    ...(issues.length ? { issues } : {}),
  };
}

export interface GridLayer {
  name: string;
  visible?: boolean;
  /** Row-major tile indices; -1 is empty. */
  data: number[][];
}

export interface GridTileset {
  name: string;
  /** Path of the image, relative to the map file. */
  image: string;
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  margin?: number;
  spacing?: number;
  /** Tile indices that are solid. */
  collides?: number[];
}

/**
 * Writes a Tiled map from plain grids.
 *
 * Used for the two maps Mosaic has any business creating: the terrain a new
 * project's template starts with, and the conversion of a tile layer painted
 * in the editor Mosaic used to have. Either way the result is an ordinary
 * `.tmj` — open it in Tiled and it is yours.
 */
export function tiledFromGrid(opts: {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  layers: GridLayer[];
  tileset: GridTileset;
}): TiledMap {
  const { tileset } = opts;
  const margin = tileset.margin ?? 0;
  const spacing = tileset.spacing ?? 0;
  const columns = Math.max(
    1,
    Math.floor((tileset.imageWidth - margin * 2 + spacing) / (tileset.tileWidth + spacing)),
  );
  const rowsOfTiles = Math.max(
    1,
    Math.floor((tileset.imageHeight - margin * 2 + spacing) / (tileset.tileHeight + spacing)),
  );

  return {
    type: "map",
    version: "1.10",
    tiledversion: "1.10.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: opts.cols,
    height: opts.rows,
    tilewidth: opts.tileWidth,
    tileheight: opts.tileHeight,
    nextlayerid: opts.layers.length + 1,
    nextobjectid: 1,
    layers: opts.layers.map((layer, i) => ({
      id: i + 1,
      name: layer.name,
      type: "tilelayer",
      visible: layer.visible ?? true,
      opacity: 1,
      x: 0,
      y: 0,
      width: opts.cols,
      height: opts.rows,
      // Tiled counts from 1 and keeps 0 for "nothing here".
      data: Array.from({ length: opts.rows * opts.cols }, (_v, n) => {
        const index = layer.data[Math.floor(n / opts.cols)]?.[n % opts.cols] ?? -1;
        return index < 0 ? 0 : index + 1;
      }),
    })),
    tilesets: [
      {
        firstgid: 1,
        name: tileset.name,
        image: tileset.image,
        imagewidth: tileset.imageWidth,
        imageheight: tileset.imageHeight,
        tilewidth: tileset.tileWidth,
        tileheight: tileset.tileHeight,
        margin,
        spacing,
        columns,
        tilecount: columns * rowsOfTiles,
        tiles: (tileset.collides ?? []).map((id) => ({
          id,
          properties: [{ name: COLLIDES_PROPERTY, type: "bool", value: true }],
        })),
      },
    ],
  };
}

export function serializeTiledMap(map: TiledMap): string {
  return JSON.stringify(map) + "\n";
}

/** A map's JSON carried inside an asset, for a project that has no folder. */
export function tiledToDataUrl(map: TiledMap): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(map))}`;
}

export function tiledFromDataUrl(url: string): TiledMap | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return null;
  try {
    const body = url.slice(comma + 1);
    const text = /;base64/i.test(url.slice(0, comma)) ? atob(body) : decodeURIComponent(body);
    return parseTiledMap(text);
  } catch {
    return null;
  }
}
