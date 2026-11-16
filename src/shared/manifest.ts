import type { AssetDef, LoaderEntry, ProjectData, SceneData, TileLayer } from "./types";
import { resolvePrefab, resolveObject, walkNodes } from "./prefabs";

/**
 * The loader manifest is derived, never hand-maintained: it is exactly the
 * assets a given scene references, in a shape `preload()` can emit directly.
 */
export function collectLoaderManifest(project: ProjectData, scene: SceneData): LoaderEntry[] {
  const needed = new Set<string>();

  // A tile layer needs its map, and the map needs the image behind each of
  // its tilesets.
  for (const layer of scene.layers) {
    if (layer.kind !== "tile") continue;
    const map = project.assets.find((a) => a.kind === "tilemap" && a.key === (layer as TileLayer).map);
    if (!map) continue;
    needed.add(map.key);
    for (const set of map.tilemap?.tilesets ?? []) if (set.image) needed.add(set.image);
  }

  for (const obj of scene.objects) {
    const resolved = resolveObject(project, obj);
    if (resolved.texture) needed.add(resolved.texture);
  }

  // Every animation's frames, not just the ones an object names on spawn: a
  // script can play any key, and a sheet that arrives unloaded is a texture
  // error at the moment the animation is asked for.
  for (const anim of project.anims) {
    for (const frame of anim.frames) needed.add(frame.textureKey);
  }

  // Every prefab's art, placed here or not. A prefab is also something the
  // game's code spawns — a bullet, an enemy from a spawner — and one that is
  // never placed in the editor still has to arrive with its texture loaded.
  // Resolved, so a variant that swapped its texture loads the one it draws.
  for (const def of project.prefabs) {
    const prefab = resolvePrefab(project, def.name);
    if (!prefab) continue;
    for (const node of walkNodes(prefab.root)) if (node.texture) needed.add(node.texture);
  }

  // Every clip the project has, for the reason every animation is registered:
  // nearly all sound is played by code — a shot, a hit, a pickup — and nothing
  // in a scene file can say which. A clip the scene's data never names used to
  // arrive unloaded, and `sound.play()` throws for a key it has not got.
  // Phaser keeps what one scene loaded, so the next scene's loader skips it.
  for (const asset of project.assets) if (asset.kind === "audio") needed.add(asset.key);

  return project.assets.filter((a) => needed.has(a.key)).map(loaderEntry);
}

export function loaderEntry(asset: AssetDef): LoaderEntry {
  switch (asset.kind) {
    case "spritesheet":
    case "tileset":
      return {
        key: asset.key,
        type: asset.kind === "tileset" ? "image" : "spritesheet",
        url: asset.url,
        frameConfig: {
          frameWidth: asset.frameWidth ?? 32,
          frameHeight: asset.frameHeight ?? 32,
          margin: asset.margin ?? 0,
          spacing: asset.spacing ?? 0,
        },
      };
    case "atlas":
      return { key: asset.key, type: "atlas", url: asset.url, frames: asset.frames ?? [] };
    case "audio":
      return { key: asset.key, type: "audio", url: asset.url };
    case "tilemap":
      return { key: asset.key, type: "tilemap", url: asset.url };
    default:
      return { key: asset.key, type: "image", url: asset.url };
  }
}
