import { DEFAULT_GROUPS, LEGACY_OBJECT_TEXTURES } from "../../shared/definitions";
import {
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  inDir,
  type AnimDef,
  type AssetDef,
  type PrefabDef,
  type ProjectConfig,
  type ProjectData,
  type ProjectPaths,
  type SceneData,
} from "../../shared/types";
import { ensureLids, walkNodes } from "../../shared/prefabs";
import { MAP_EXT, serializeTiledMap, tiledFromDataUrl, type TiledMap } from "../../shared/tiled";
import type { DiskFile, ExistingProject, ProjectSource } from "../platform/types";
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
export const scenePath = (key: string, paths: Pick<ProjectPaths, "scenes"> = DEFAULT_PATHS) =>
  inDir(paths.scenes, `${key}.scene.json`);
/**
 * A prefab is a file, not a row in the manifest. It has its own history, its
 * own diff and its own line in a review — which is the whole point of an
 * object being reusable across scenes several people are editing.
 */
export const prefabPath = (name: string, paths: Pick<ProjectPaths, "prefabs"> = DEFAULT_PATHS) =>
  inDir(paths.prefabs, `${name}.prefab.json`);

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
}

/** The manifest as it ships: asset metadata and paths, never asset bytes. */
export function toManifest(project: ProjectData): ProjectManifest {
  return {
    name: project.name,
    scenes: project.scenes.map((s) => ({
      key: s.key,
      name: s.name,
      file: scenePath(s.key, project.config.paths),
    })),
    assets: project.assets.map(({ url: _url, ...rest }) => rest),
    // By name, the order they are read back in, so opening a project does
    // not rewrite this file just to reorder it.
    prefabs: [...project.prefabs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p, file: prefabPath(p.name, project.config.paths) })),
    anims: project.anims,
    groups: project.groups,
  };
}

export function projectToFiles(project: ProjectData): DiskFile[] {
  return [
    { rel: MANIFEST_PATH, contents: JSON.stringify(toManifest(project), null, 2) + "\n" },
    // Scene defaults live in their own file, so a developer can read and edit
    // them without wading through the editor's manifest.
    { rel: CONFIG_PATH, contents: serializeConfig(project.config) },
    ...project.scenes.map((scene) => ({
      rel: scenePath(scene.key, project.config.paths),
      contents: JSON.stringify(scene, null, 2) + "\n",
    })),
    ...project.prefabs.map((prefab) => ({
      rel: prefabPath(prefab.name, project.config.paths),
      contents: JSON.stringify(prefab, null, 2) + "\n",
    })),
    ...pendingTilemaps(project).map(({ asset, map }) => ({
      rel: asset.path,
      contents: serializeTiledMap(map),
    })),
  ];
}

/**
 * Maps Mosaic made and has not yet put on disk: a template's terrain, or a
 * converted tile layer. Each is written once, by the first save, and is a
 * file edited in Tiled from then on — Mosaic never writes it a second time.
 */
export function pendingTilemaps(project: ProjectData): { asset: AssetDef; map: TiledMap }[] {
  const out: { asset: AssetDef; map: TiledMap }[] = [];
  for (const asset of project.assets) {
    if (asset.kind !== "tilemap" || !asset.url.startsWith("data:")) continue;
    const map = tiledFromDataUrl(asset.url);
    if (map) out.push({ asset, map });
  }
  return out;
}

export interface LoadResult {
  project: ProjectData;
  issues: string[];
  /** True when the folder held nothing Mosaic recognised. */
  scaffolded: boolean;
  /**
   * Hold every write back until the user asks for one.
   *
   * Set when a starter was generated into a folder that already belongs to
   * somebody — the editor has something to show, but nothing about that is
   * worth putting on their disk unprompted.
   */
  deferWrite: boolean;
  /**
   * Set when the folder is a Phaser game Mosaic has never written to. The
   * project comes back with no scenes: the game's own scene classes are what
   * there is to lay out, and which one is the user's call.
   */
  adopt?: ExistingProject;
}

/**
 * mosaic.config.json as written, in one key order whoever writes it.
 *
 * The New Project flow and a save used to order the keys differently, so the
 * first open of every new project rewrote the file and left a diff in git that
 * nobody had made.
 */
export function serializeConfig(config: ProjectConfig): string {
  const { canvas, tile, scale, physics, pixelArt, placeholders, phaser, language, paths, ...rest } = config;
  const ordered = {
    canvas,
    tile,
    scale,
    physics,
    pixelArt,
    ...(placeholders === false ? { placeholders } : {}),
    ...(phaser === "global" ? { phaser } : {}),
    ...(language ? { language } : {}),
    paths,
    ...rest,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
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
    ...(parsed.placeholders === false ? { placeholders: false } : {}),
    ...(parsed.phaser === "global" ? { phaser: "global" as const } : {}),
    ...(parsed.language === "ts" || parsed.language === "js" ? { language: parsed.language } : {}),
    paths: {
      src: parsed.paths?.src ?? DEFAULT_PATHS.src,
      scenes: parsed.paths?.scenes ?? DEFAULT_PATHS.scenes,
      prefabs: parsed.paths?.prefabs ?? DEFAULT_PATHS.prefabs,
      assets: parsed.paths?.assets ?? DEFAULT_PATHS.assets,
      ...(parsed.paths?.publicDir ? { publicDir: parsed.paths.publicDir } : {}),
    },
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

  // Somebody's Phaser game. It is opened as itself: its art where it keeps
  // it, its canvas size, and none of Mosaic's starter content — no sample
  // scene, no Player and Pickup prefabs, no genre-named groups. Nothing is
  // written until a scene is picked to lay out. (A Phaser 2 game never gets
  // here: the workspace refuses it before reading.)
  if (!manifest && !scenes.length && source.existing) {
    const existing = source.existing;
    const config = structuredClone(DEFAULT_CONFIG);
    config.paths = { ...config.paths, ...existing.paths };
    if (existing.canvas) config.canvas = { ...existing.canvas };
    // Its own settings, not Mosaic's defaults: a layout that sets up Arcade in
    // a game without it throws, and pixel-art rendering is a look the game
    // either chose or did not.
    config.physics = existing.physics;
    config.pixelArt = existing.pixelArt;
    config.language = existing.language;
    if (existing.phaserAccess === "global") config.phaser = "global";
    // Its art is its own. Mosaic's placeholder shapes exist as files only in
    // projects Mosaic scaffolded, so they are not offered here at all.
    config.placeholders = false;
    const project: ProjectData = {
      name: folderName,
      config,
      scenes: [],
      prefabs: [],
      anims: [],
      groups: [],
      assets: reconcileAssets([], source.assets, assetUrl, issues, config.paths.assets, false),
    };
    return { project, issues, scaffolded: false, deferWrite: true, adopt: existing };
  }

  // Nothing recognisable: scaffold a starter so a brand-new folder is usable.
  if (!manifest && !scenes.length) {
    const starter = createStarterProject();
    starter.name = folderName;
    // Art already sitting in the folder is still the project's art, even when
    // nothing else in it is ours — a folder someone dropped sprites into
    // before opening it is the ordinary case, not a strange one. Reconciling
    // here rather than returning early also keeps the scaffold's own save
    // honest: the manifest it writes lists what is actually on disk, so the
    // first open and every later one agree.
    starter.assets = reconcileAssets(starter.assets, source.assets, assetUrl, issues, starter.config.paths.assets, true);

    // An EMPTY folder is an invitation: scaffold into it and write, so what is
    // on disk matches what the editor shows. A folder that already holds
    // somebody's work is not. Mosaic cannot read a hand-written Phaser project,
    // and a project it cannot read is indistinguishable here from an empty
    // one — so writing a starter into it drops five files into a repo the user
    // never asked us to touch, and buries their game under a sample scene.
    //
    // The starter still opens, so the editor is usable rather than blank. It
    // just stays unsaved until the user asks for it.
    if (source.occupied) {
      issues.push(
        "This folder already has files in it but no Mosaic project — showing a starter scene WITHOUT writing anything. Save to create the project here.",
      );
      return { project: starter, issues, scaffolded: true, deferWrite: true };
    }
    return { project: starter, issues, scaffolded: true, deferWrite: false };
  }

  const config = readConfig(source.config, issues);
  const assets = reconcileAssets(
    manifest?.assets ?? [],
    source.assets,
    assetUrl,
    issues,
    config.paths.assets,
    config.placeholders !== false,
  );

  const project: ProjectData = {
    name: manifest?.name ?? folderName,
    config,
    scenes: scenes.length ? scenes : createStarterProject().scenes,
    prefabs: readPrefabs(source.prefabs, manifest, issues, config.paths),
    anims: manifest?.anims ?? [],
    // An empty list is a choice — an adopted game starts with none — so only
    // a manifest that never had the field gets the defaults.
    groups: manifest?.groups ? manifest.groups : [...DEFAULT_GROUPS],
    assets,
  };

  if (!scenes.length) issues.push("No scene files found — started you on a fresh scene.");
  migrateLegacyTextures(project, issues);
  migrateLegacyAnimLoop(project, issues);
  dropScriptComponents(project, issues);
  orderScenes(project, manifest);
  return { project, issues, scaffolded: false, deferWrite: false };
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

/**
 * `loop: boolean` became `repeat: number`, because a boolean could only say
 * forever or once. A folder written before that is converted on the way in and
 * the old field dropped, so nothing downstream has to keep reading both.
 */
function migrateLegacyAnimLoop(project: ProjectData, issues: string[]): void {
  let moved = 0;
  for (const anim of project.anims) {
    if (typeof anim.repeat === "number") {
      delete anim.loop;
      continue;
    }
    anim.repeat = anim.loop ? -1 : 0;
    delete anim.loop;
    moved += 1;
  }
  if (moved) {
    issues.push(`Converted ${moved} animation(s) from loop to a repeat count — save to write it back`);
  }
}

/**
 * Script components were removed: behaviour lives in prefab classes and the
 * scene class, the way it does in any Phaser game. A folder written while they
 * existed still names them on its objects. Those references are dropped on the
 * way in, with a note, and the classes themselves are left alone: they are the
 * project's code, and moving their logic is the developer's call.
 */
function dropScriptComponents(project: ProjectData, issues: string[]): void {
  const isScriptPath = (path: string) => path === "scripts" || path.startsWith("scripts.");
  const dropPaths = (record: Record<string, unknown> | undefined) => {
    if (!record) return false;
    let hit = false;
    for (const key of Object.keys(record)) {
      if (isScriptPath(key)) {
        delete record[key];
        hit = true;
      }
    }
    return hit;
  };
  let objects = 0;
  const strip = (holder: object) => {
    const h = holder as { scripts?: unknown[]; overrides?: Record<string, unknown> };
    const had = Array.isArray(h.scripts) && h.scripts.length > 0;
    delete h.scripts;
    if (dropPaths(h.overrides) || had) objects += 1;
  };

  for (const scene of project.scenes) for (const obj of scene.objects) strip(obj);
  for (const prefab of project.prefabs) {
    if (prefab.root) for (const node of walkNodes(prefab.root)) strip(node);
    if (dropPaths(prefab.diff as Record<string, unknown> | undefined)) objects += 1;
    if (prefab.exposed) prefab.exposed = prefab.exposed.filter((path) => !isScriptPath(path));
  }

  if (objects) {
    issues.push(
      `${objects} object(s) had script components, which Mosaic no longer generates. ` +
        "Their classes are untouched: move that behaviour into a prefab class or the scene class, then save.",
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
  paths: ProjectPaths,
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
      `Prefab "${entry.name}" was read from the manifest rather than its own file — saving writes ${prefabPath(entry.name, paths)}`,
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
  assetDir: string,
  placeholders: boolean,
): AssetDef[] {
  const diskByPath = new Map(onDisk.map((a) => [a.rel, a]));
  const out: AssetDef[] = [];
  const claimed = new Set<string>();

  for (const asset of declared) {
    if (asset.generated) {
      // Procedural placeholders are drawn by the editor. A scaffolded project
      // also has them on disk, for the game to load — the same asset, so the
      // file is claimed here rather than listed a second time below.
      claimed.add(asset.path);
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
    // Tiled maps and atlas documents are read by content, not guessed at by
    // name — the workspace does that once it can open the files.
    if (MAP_EXT.test(file.rel)) continue;
    // Named from inside the art folder, so `public/assets/star.png` is `star`
    // — the key a game's own code most likely loads it by — and not
    // `public_assets_star`.
    const inside = file.rel.startsWith(`${assetDir}/`) ? file.rel.slice(assetDir.length + 1) : file.rel;
    const base = inside.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_");
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
  if (placeholders && !out.some((a) => a.generated)) {
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
