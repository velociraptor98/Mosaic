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

  // Prefab definitions used by this scene pull in their own art — resolved,
  // so a variant that swapped its texture loads the one it actually draws.
  for (const obj of scene.objects) {
    if (!obj.prefab) continue;
    const prefab = resolvePrefab(project, obj.prefab);
    if (!prefab) continue;
    for (const node of walkNodes(prefab.root)) if (node.texture) needed.add(node.texture);
  }

  // Audio the scene actually references. Clips used to load only if something
  // else happened to pull them in, because nothing in the format named one.
  for (const obj of scene.objects) {
    const resolved = resolveObject(project, obj);
    if (resolved.sounds?.spawn) needed.add(resolved.sounds.spawn);
  }
  if (scene.settings.music?.key) needed.add(scene.settings.music.key);

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
