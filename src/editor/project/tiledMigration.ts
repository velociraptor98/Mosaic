import {
  MAP_DIR,
  describeTiledMap,
  tiledFromGrid,
  tiledToDataUrl,
  type GridLayer,
} from "../../shared/tiled";
import type { AssetDef, Layer, ProjectData, TileLayer } from "../../shared/types";
import { uid, uniqueKey, uniqueName } from "../store/ids";

/**
 * A tile layer as Mosaic stored it when it painted tiles itself: the grid was
 * in the scene file, and the tileset was an asset with collision flags on it.
 */
interface PaintedTileLayer {
  id: string;
  name: string;
  kind: "tile";
  visible: boolean;
  locked: boolean;
  tilesetId: string;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
  data: number[][];
}

function isPainted(layer: Layer | PaintedTileLayer): layer is PaintedTileLayer {
  return layer.kind === "tile" && Array.isArray((layer as PaintedTileLayer).data);
}

/** `assets/maps/x.tmj` -> `../tiles.png` for `assets/tiles.png`. */
function relativeTo(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/");
}

/**
 * Converts painted tile layers into Tiled maps, in place.
 *
 * Nothing is lost: every layer becomes a layer of a `.tmj` with the same
 * tiles in the same cells, drawn with the same image, and the tiles that were
 * flagged solid carry the `collides` property instead. The scene keeps a row
 * per layer, in the order it had, pointing at the map.
 *
 * The maps are returned inside the project as data: URLs; the next save
 * writes them to disk. Layers of one scene that share a grid share a map.
 */
export function migratePaintedTileLayers(project: ProjectData): string[] {
  const notes: string[] = [];
  const mapKeys = project.assets.map((a) => a.key);
  const mapPaths = new Set(project.assets.map((a) => a.path));

  for (const scene of project.scenes) {
    const layers = scene.layers as (Layer | PaintedTileLayer)[];
    const painted = layers.filter(isPainted);
    if (!painted.length) continue;

    const groups = new Map<string, PaintedTileLayer[]>();
    for (const layer of painted) {
      const sig = `${layer.tilesetId}:${layer.tileWidth}x${layer.tileHeight}:${layer.cols}x${layer.rows}`;
      groups.set(sig, [...(groups.get(sig) ?? []), layer]);
    }

    const replaced = new Map<string, TileLayer | null>();
    let n = 0;
    for (const members of groups.values()) {
      const first = members[0];
      const tileset = project.assets.find((a) => a.id === first.tilesetId);
      if (!tileset) {
        for (const layer of members) replaced.set(layer.id, null);
        notes.push(`${scene.key}: dropped ${members.length} tile layer(s) whose tileset no longer exists`);
        continue;
      }

      let path = `${MAP_DIR}/${scene.key}${n ? `-${n + 1}` : ""}.tmj`;
      while (mapPaths.has(path)) path = `${MAP_DIR}/${scene.key}-${++n + 1}.tmj`;
      mapPaths.add(path);
      n += 1;
      const key = uniqueKey(scene.key, mapKeys);
      mapKeys.push(key);

      const names: string[] = [];
      const grid: GridLayer[] = members.map((layer) => {
        const name = uniqueName(layer.name, names);
        names.push(name);
        return { name, visible: layer.visible, data: layer.data };
      });
      const tileWidth = tileset.frameWidth ?? first.tileWidth;
      const tileHeight = tileset.frameHeight ?? first.tileHeight;
      const map = tiledFromGrid({
        cols: first.cols,
        rows: first.rows,
        tileWidth: first.tileWidth,
        tileHeight: first.tileHeight,
        layers: grid,
        tileset: {
          name: tileset.key,
          image: relativeTo(path, tileset.path),
          imageWidth: tileset.width || tileWidth,
          imageHeight: tileset.height || tileHeight,
          tileWidth,
          tileHeight,
          margin: tileset.margin,
          spacing: tileset.spacing,
          collides: tileset.tileCollides,
        },
      });

      const asset: AssetDef = {
        id: uid("asset"),
        key,
        kind: "tilemap",
        path,
        url: tiledToDataUrl(map),
        width: first.cols * first.tileWidth,
        height: first.rows * first.tileHeight,
        tilemap: describeTiledMap(map, path, project.assets),
      };
      project.assets.push(asset);

      members.forEach((layer, i) => {
        replaced.set(layer.id, {
          id: layer.id,
          name: layer.name,
          kind: "tile",
          visible: layer.visible,
          locked: layer.locked,
          map: key,
          layer: grid[i].name,
        });
      });
      notes.push(`${scene.key}: ${members.length} painted tile layer(s) are now ${path} — edit it in Tiled`);
    }

    scene.layers = layers
      .map((layer) => (replaced.has(layer.id) ? replaced.get(layer.id)! : (layer as Layer)))
      .filter((layer): layer is Layer => layer !== null);
  }

  // The image is an image now. What made it a tileset — the tile size and the
  // solid flags — went into the map, which is where Tiled keeps them.
  if (notes.length) {
    for (const asset of project.assets) {
      if (asset.kind !== "tileset") continue;
      asset.kind = "image";
      delete asset.tileCollides;
      delete asset.frameWidth;
      delete asset.frameHeight;
    }
  }
  return notes;
}
