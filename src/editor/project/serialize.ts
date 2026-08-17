import { DEFAULT_GROUPS } from "../../shared/definitions";
import type {
  AnimDef,
  AssetDef,
  CollisionRule,
  PrefabDef,
  ProjectData,
  SceneData,
} from "../../shared/types";
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
export const scenePath = (key: string) => `src/scenes/${key}.scene.json`;

export interface ProjectManifest {
  name: string;
  scenes: { key: string; name: string; file: string }[];
  assets: Omit<AssetDef, "url">[];
  prefabs: PrefabDef[];
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
    prefabs: project.prefabs,
    anims: project.anims,
    groups: project.groups,
    collision: project.collision,
  };
}

export function projectToFiles(project: ProjectData): DiskFile[] {
  return [
    { rel: MANIFEST_PATH, contents: JSON.stringify(toManifest(project), null, 2) + "\n" },
    ...project.scenes.map((scene) => ({
      rel: scenePath(scene.key),
      contents: JSON.stringify(scene, null, 2) + "\n",
    })),
  ];
}

export interface LoadResult {
  project: ProjectData;
  issues: string[];
  /** True when the folder held nothing Mosaic recognised. */
  scaffolded: boolean;
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
    scenes: scenes.length ? scenes : createStarterProject().scenes,
    prefabs: manifest?.prefabs ?? [],
    anims: manifest?.anims ?? [],
    groups: manifest?.groups?.length ? manifest.groups : [...DEFAULT_GROUPS],
    collision: manifest?.collision ?? {},
    assets,
  };

  if (!scenes.length) issues.push("No scene files found — started you on a fresh scene.");
  orderScenes(project, manifest);
  return { project, issues, scaffolded: false };
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
