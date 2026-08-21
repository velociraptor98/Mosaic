import { DEFAULT_GROUPS, LEGACY_OBJECT_TEXTURES } from "../../shared/definitions";
import {
  DEFAULT_CONFIG,
  type AnimDef,
  type AssetDef,
  type CollisionRule,
  type PrefabDef,
  type ProjectConfig,
  type ProjectData,
  type SceneData,
} from "../../shared/types";
import { ensureLids, walkNodes } from "../../shared/prefabs";
import type { DiskFile, ProjectSource } from "../platform/types";
import { createStarterProject, placeholderObjectAssets, placeholderTilesetAsset } from "../store/templates";

/**
 * ProjectData <-> files on disk.
 *
 * This is the round trip the browser build never had: export used to be
 * one-way, so a folder Mosaic had written could not be opened again. The
 * manifest below is the same shape the exporter emits, which is what lets the
 * editor treat the scene files as the source of truth.
 */

export const MANIFEST_PATH = "phaser.editor.json";
export const CONFIG_PATH = "mosaic.config.json";
export const scenePath = (key: string) => `src/scenes/${key}.scene.json`;
/**
 * A prefab is a file, not a row in the manifest. It has its own history, its
 * own diff and its own line in a review — which is the whole point of an
 * object being reusable across scenes several people are editing.
 */
export const prefabPath = (name: string) => `src/prefabs/${name}.prefab.json`;

export interface ProjectManifest {
  name: string;
  scenes: { key: string; name: string; file: string }[];
  assets: Omit<AssetDef, "url">[];
  /**
   * Prefab definitions, plus the file each one is authored in.
   *
   * The files are the source of truth and are what a reader prefers — that is
   * what keeps two people editing two prefabs out of one file. The manifest
   * carries the definitions anyway because it is also the RUNTIME's payload: a
   * game that imports this and calls `buildScene` has no filesystem to go and
   * read the other files with, and an index of filenames left every prefab
   * instance in the scene unresolvable.
   */
  prefabs: (PrefabDef & { file?: string })[];
  anims: AnimDef[];
  groups: string[];
  collision: Record<string, Record<string, CollisionRule>>;
}

/** The manifest as it ships: asset metadata and paths, never asset bytes. */
export function toManifest(project: ProjectData): ProjectManifest {
  return {
    name: project.name,
    scenes: project.scenes.map((s) => ({ key: s.key, name: s.name, file: scenePath(s.key) })),
    assets: project.assets.map(({ url: _url, ...rest }) => rest),
    prefabs: project.prefabs.map((p) => ({ ...p, file: prefabPath(p.name) })),
    anims: project.anims,
    groups: project.groups,
    collision: project.collision,
  };
}

export function projectToFiles(project: ProjectData): DiskFile[] {
  return [
    { rel: MANIFEST_PATH, contents: JSON.stringify(toManifest(project), null, 2) + "\n" },
    // Scene defaults live in their own file, so a developer can read and edit
    // them without wading through the editor's manifest.
    { rel: CONFIG_PATH, contents: JSON.stringify(project.config, null, 2) + "\n" },
    ...project.scenes.map((scene) => ({
      rel: scenePath(scene.key),
      contents: JSON.stringify(scene, null, 2) + "\n",
    })),
    ...project.prefabs.map((prefab) => ({
      rel: prefabPath(prefab.name),
      contents: JSON.stringify(prefab, null, 2) + "\n",
    })),
  ];
}

export interface LoadResult {
  project: ProjectData;
  issues: string[];
  /** True when the folder held nothing Mosaic recognised. */
  scaffolded: boolean;
}

/** mosaic.config.json, defaulted field by field so a partial file still opens. */
function readConfig(contents: string | null | undefined, issues: string[]): ProjectConfig {
  if (!contents) return structuredClone(DEFAULT_CONFIG);
  const parsed = parse<Partial<ProjectConfig>>(contents, CONFIG_PATH, issues);
  if (!parsed) return structuredClone(DEFAULT_CONFIG);
  return {
    canvas: {
      width: parsed.canvas?.width ?? DEFAULT_CONFIG.canvas.width,
      height: parsed.canvas?.height ?? DEFAULT_CONFIG.canvas.height,
    },
    tile: parsed.tile ?? DEFAULT_CONFIG.tile,
    scale: parsed.scale ?? DEFAULT_CONFIG.scale,
    physics: parsed.physics ?? DEFAULT_CONFIG.physics,
    pixelArt: parsed.pixelArt ?? DEFAULT_CONFIG.pixelArt,
  };
}

function parse<T>(contents: string, label: string, issues: string[]): T | null {
  try {
    return JSON.parse(contents) as T;
  } catch (err) {
    issues.push(`${label}: ${(err as Error).message}`);
    return null;
  }
}

function isScene(value: unknown): value is SceneData {
  const s = value as SceneData | null;
  return !!s && typeof s.key === "string" && Array.isArray(s.layers) && Array.isArray(s.objects);
}

/**
 * Reads a folder into a project. Tolerant by design: a folder with a missing
 * manifest, an unreadable scene or art that was dropped in by hand should open
 * with a warning, not fail.
 */
export function projectFromSource(
  source: ProjectSource,
  folderName: string,
  assetUrl: (rel: string) => string,
): LoadResult {
  const issues: string[] = [];
  const manifest = source.manifest
    ? parse<ProjectManifest>(source.manifest, MANIFEST_PATH, issues)
    : null;

  const scenes: SceneData[] = [];
  for (const file of source.scenes) {
    const parsed = parse<SceneData>(file.contents, file.rel, issues);
    if (!parsed) continue;
    if (!isScene(parsed)) {
      issues.push(`${file.rel}: not a scene file (missing key/layers/objects)`);
      continue;
    }
    scenes.push(parsed);
  }

  // Nothing recognisable: scaffold a starter so a brand-new folder is usable.
  if (!manifest && !scenes.length) {
    const starter = createStarterProject();
    starter.name = folderName;
    return { project: starter, issues, scaffolded: true };
  }

  const assets = reconcileAssets(manifest?.assets ?? [], source.assets, assetUrl, issues);

  const project: ProjectData = {
    name: manifest?.name ?? folderName,
    config: readConfig(source.config, issues),
    scenes: scenes.length ? scenes : createStarterProject().scenes,
    prefabs: readPrefabs(source.prefabs, manifest, issues),
    anims: manifest?.anims ?? [],
    groups: manifest?.groups?.length ? manifest.groups : [...DEFAULT_GROUPS],
    collision: manifest?.collision ?? {},
    assets,
  };

  if (!scenes.length) issues.push("No scene files found — started you on a fresh scene.");
  migrateLegacyTextures(project, issues);
  orderScenes(project, manifest);
  return { project, issues, scaffolded: false };
}

/**
 * Placeholder textures used to be named after six built-in game roles
 * (`obj-player`, `obj-crate`). They are named after the SHAPE they draw now,
 * because a project that is not a platformer should not carry another game's
 * nouns. A folder written before that rename is repointed on the way in, so it
 * opens with its art attached rather than with six missing textures.
 */
function migrateLegacyTextures(project: ProjectData, issues: string[]): void {
  let moved = 0;
  const repoint = (holder: { texture?: string }) => {
    const next = holder.texture ? LEGACY_OBJECT_TEXTURES[holder.texture] : undefined;
    if (!next) return;
    holder.texture = next;
    moved += 1;
  };

  for (const scene of project.scenes) for (const obj of scene.objects) repoint(obj);
  for (const prefab of project.prefabs) {
    if (prefab.root) for (const node of walkNodes(prefab.root)) repoint(node);
  }
  for (const anim of project.anims) {
    for (const frame of anim.frames) {
      const next = LEGACY_OBJECT_TEXTURES[frame.textureKey];
      if (next) {
        frame.textureKey = next;
        moved += 1;
      }
    }
  }
  // The old generated assets are replaced wholesale by the shape set, so any
  // still declared in the manifest would be a second, dead copy.
  project.assets = project.assets.filter(
    (a) => !(a.generated && LEGACY_OBJECT_TEXTURES[a.key]),
  );

  if (moved) {
    issues.push(
      `Repointed ${moved} placeholder texture reference(s) to the shape they draw — save to write it back`,
    );
  }
}

function isPrefab(value: unknown): value is PrefabDef {
  const p = value as PrefabDef | null;
  if (!p || typeof p.name !== "string") return false;
  // A base owns a tree; a variant owns a base to inherit from. Anything with
  // neither is not a definition, however well-formed the JSON is.
  return !!p.root || !!p.base;
}

/**
 * Definitions come from src/prefabs/. A folder written by an older build has
 * them inlined in the manifest instead, and is read that way — otherwise
 * opening it would silently unpack every instance in the project.
 */
function readPrefabs(
  files: DiskFile[],
  manifest: ProjectManifest | null,
  issues: string[],
): PrefabDef[] {
  const out: PrefabDef[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const parsed = parse<PrefabDef>(file.contents, file.rel, issues);
    if (!parsed) continue;
    if (!isPrefab(parsed)) {
      issues.push(`${file.rel}: not a prefab file (needs a root, or a base to inherit from)`);
      continue;
    }
    if (parsed.root) ensureLids(parsed.root);
    parsed.exposed = parsed.exposed ?? [];
    seen.add(parsed.name);
    out.push(parsed);
  }

  for (const entry of manifest?.prefabs ?? []) {
    if (!isPrefab(entry) || seen.has(entry.name)) continue;
    if (entry.root) ensureLids(entry.root);
    entry.exposed = entry.exposed ?? [];
    issues.push(
      `Prefab "${entry.name}" was read from the manifest rather than its own file — saving writes ${prefabPath(entry.name)}`,
    );
    out.push(entry);
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The manifest describes assets; the folder holds them. Where they disagree,
 * the folder wins for existence and the manifest wins for metadata — art
 * dropped into assets/ by hand shows up, and art deleted by hand is reported.
 */
function reconcileAssets(
  declared: Omit<AssetDef, "url">[],
  onDisk: { rel: string; bytes: number }[],
  assetUrl: (rel: string) => string,
  issues: string[],
): AssetDef[] {
  const diskByPath = new Map(onDisk.map((a) => [a.rel, a]));
  const out: AssetDef[] = [];
  const claimed = new Set<string>();

  for (const asset of declared) {
    if (asset.generated) {
      // Procedural placeholders have no file; the editor draws them.
      out.push({ ...asset, url: "" } as AssetDef);
      continue;
    }
    if (!diskByPath.has(asset.path)) {
      issues.push(`Asset "${asset.key}" is in the manifest but missing from disk (${asset.path})`);
      continue;
    }
    claimed.add(asset.path);
    out.push({ ...asset, url: assetUrl(asset.path) } as AssetDef);
  }

  const keys = new Set(out.map((a) => a.key));
  for (const file of onDisk) {
    if (claimed.has(file.rel)) continue;
    const base = file.rel.replace(/^assets\//, "").replace(/\.\w+$/, "").replace(/[^\w]+/g, "_");
    let key = base || "asset";
    let n = 2;
    while (keys.has(key)) key = `${base}_${n++}`;
    keys.add(key);
    out.push({
      id: `asset-${key}`,
      key,
      kind: /\.(mp3|ogg|wav|m4a)$/i.test(file.rel) ? "audio" : "image",
      path: file.rel,
      url: assetUrl(file.rel),
      width: 0,
      height: 0,
    });
  }

  // A folder written by an older build may predate the placeholder assets.
  if (!out.some((a) => a.generated)) {
    out.unshift(placeholderTilesetAsset(), ...placeholderObjectAssets());
  }
  return out;
}

function orderScenes(project: ProjectData, manifest: ProjectManifest | null): void {
  if (!manifest?.scenes?.length) return;
  const order = manifest.scenes.map((s) => s.key);
  project.scenes.sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });
}
