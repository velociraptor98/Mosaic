import type { AssetDef, LoaderEntry, ProjectData, SceneData, TileLayer } from "./types";
import { resolvePrefab, resolveObject, walkNodes } from "./prefabs";

/**
 * The loader manifest is derived, never hand-maintained: it is exactly the
 * assets a given scene references, in a shape `preload()` can emit directly.
 */
export function collectLoaderManifest(project: ProjectData, scene: SceneData): LoaderEntry[] {
  const needed = new Set<string>();

  for (const layer of scene.layers) {
    if (layer.kind === "tile") {
      const tileset = project.assets.find((a) => a.id === (layer as TileLayer).tilesetId);
      if (tileset) needed.add(tileset.key);
    }
  }

  for (const obj of scene.objects) {
    const resolved = resolveObject(project, obj);
    if (resolved.texture) needed.add(resolved.texture);
    if (resolved.playOnSpawn) {
      const anim = project.anims.find((a) => a.key === resolved.playOnSpawn);
      for (const f of anim?.frames ?? []) needed.add(f.textureKey);
    }
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
    if (resolved.sounds?.overlap) needed.add(resolved.sounds.overlap);
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
    default:
      return { key: asset.key, type: "image", url: asset.url };
  }
}

/** Every texture key the project knows about, for Inspector pickers. */
export function textureChoices(project: ProjectData): { key: string; frames: string[] }[] {
  return project.assets
    .filter((a) => a.kind !== "audio")
    .map((a) => ({
      key: a.key,
      frames: a.kind === "atlas" ? (a.frames ?? []).map((f) => f.name) : [],
    }));
}
