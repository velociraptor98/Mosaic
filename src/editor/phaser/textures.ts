import Phaser from "phaser";
import { ensurePlaceholderTextures } from "../../shared/textures";
import type { ProjectData } from "../../shared/types";

const LOADED_URLS = "editor:loadedTextureUrls";

/**
 * Keeps the Phaser texture manager in step with the project's asset list.
 * Imported art arrives as a data: URL, so a re-import swaps the texture in
 * place without restarting the editor.
 */
export function syncTextures(
  scene: Phaser.Scene,
  project: ProjectData,
  onDone?: () => void,
): void {
  ensurePlaceholderTextures(scene);
  if (scene.load.isLoading()) return; // a sync is already in flight

  // Bytes we last loaded per key. Re-imported art has the same key and
  // different bytes, which is what makes hot reload possible without a restart.
  let loaded = scene.registry.get(LOADED_URLS) as Map<string, string> | undefined;
  if (!loaded) {
    loaded = new Map<string, string>();
    scene.registry.set(LOADED_URLS, loaded);
  }

  let queued = 0;
  for (const asset of project.assets) {
    if (!asset.url || asset.kind === "audio") continue;
    const previous = loaded.get(asset.key);
    if (previous !== undefined && previous !== asset.url) {
      invalidateTexture(scene, asset.key);
    }
    if (scene.textures.exists(asset.key)) continue;
    loaded.set(asset.key, asset.url);
    queued += 1;
    if (asset.kind === "spritesheet") {
      scene.load.spritesheet(asset.key, asset.url, {
        frameWidth: asset.frameWidth ?? 32,
        frameHeight: asset.frameHeight ?? 32,
        margin: asset.margin ?? 0,
        spacing: asset.spacing ?? 0,
      });
    } else {
      scene.load.image(asset.key, asset.url);
    }
  }

  if (!queued) {
    registerAtlasFrames(scene, project);
    onDone?.();
    return;
  }

  scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
    registerAtlasFrames(scene, project);
    onDone?.();
  });
  scene.load.start();
}

/** Atlas frames are sliced in the editor, so they are added by hand. */
export function registerAtlasFrames(scene: Phaser.Scene, project: ProjectData): void {
  for (const asset of project.assets) {
    if (asset.kind !== "atlas" || !asset.frames?.length) continue;
    if (!scene.textures.exists(asset.key)) continue;
    const texture = scene.textures.get(asset.key);
    for (const frame of asset.frames) {
      if (texture.has(frame.name)) continue;
      texture.add(frame.name, 0, frame.x, frame.y, frame.w, frame.h);
    }
  }
}

/** Drop a texture so the next sync reloads it from changed bytes. */
export function invalidateTexture(scene: Phaser.Scene, key: string): void {
  if (scene.textures.exists(key)) scene.textures.remove(key);
}
