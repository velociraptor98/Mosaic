import fs from "node:fs/promises";
import path from "node:path";
import type { AssetFileInfo, ProjectFiles, ScriptFileIpc } from "./contract";

/**
 * Reading a project folder off disk: the half of the main process that needs
 * nothing from Electron.
 *
 * Kept apart from ipc.ts so that a check run in plain Node — `npm run check`
 * — reads a project exactly the way the app does, rather than through a copy
 * that could drift from it.
 */

export const MANIFEST = "phaser.editor.json";
export const CONFIG = "mosaic.config.json";
export const DEFAULT_SCENE_DIR = "src/scenes";
export const DEFAULT_SRC_DIR = "src";
export const DEFAULT_PREFAB_DIR = "src/prefabs";
export const ASSET_DIR = "assets";

export interface Paths {
  src: string;
  scenes: string;
  prefabs: string;
  assets: string;
}

/**
 * Where this project keeps things, per its own config.
 *
 * Read fresh rather than cached: the config is a file the user can edit in
 * their own editor, and a stale layout is worse than a re-read.
 */
export async function projectPaths(root: string): Promise<Paths> {
  const raw = await readIfExists(path.join(root, CONFIG));
  let parsed: { paths?: Partial<Paths> } = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const clean = (v: string | undefined, fallback: string) => {
    const t = (v ?? "").trim().replace(/^\/+|\/+$/g, "");
    // A path that escapes the root is not a layout choice, it is a bug or an
    // attack; either way the default is the safe answer.
    return !t || t.startsWith("..") ? fallback : t;
  };
  return {
    src: clean(parsed.paths?.src, DEFAULT_SRC_DIR),
    scenes: clean(parsed.paths?.scenes, DEFAULT_SCENE_DIR),
    prefabs: clean(parsed.paths?.prefabs, DEFAULT_PREFAB_DIR),
    assets: clean(parsed.paths?.assets, ASSET_DIR),
  };
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const AUDIO_EXT = /\.(mp3|ogg|wav|m4a)$/i;
/** Tiled maps, and documents that might be one. The renderer opens them to find out. */
export const MAP_EXT = /\.(tmj|json)$/i;

export function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

// ------------------------------------------------------------ file reading

export async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

export async function readDirFiles(
  root: string,
  dir: string,
  match: RegExp,
): Promise<{ rel: string; contents: string }[]> {
  const abs = path.join(root, dir);
  let names: string[];
  try {
    names = await fs.readdir(abs);
  } catch {
    return [];
  }
  const out: { rel: string; contents: string }[] = [];
  for (const name of names.sort()) {
    if (!match.test(name)) continue;
    const contents = await readIfExists(path.join(abs, name));
    if (contents !== null) out.push({ rel: toPosix(path.join(dir, name)), contents });
  }
  return out;
}

/**
 * Does this folder already hold somebody's codebase?
 *
 * The question is not "is it empty" — a folder someone dropped sprites into
 * before opening it is still ours to scaffold, and that is a normal way to
 * start. The question is whether there is SOURCE here, because that is what
 * Mosaic cannot read and must not bury under a starter scene.
 *
 * So: art and dotfiles do not count, and anything else does.
 */
export async function isOccupied(root: string, paths: Paths): Promise<boolean> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.some((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (entry.isDirectory()) return entry.name !== paths.assets.split("/")[0];
      return !IMAGE_EXT.test(entry.name) && !AUDIO_EXT.test(entry.name);
    });
  } catch {
    return false;
  }
}

export async function listAssets(root: string, assetDir: string): Promise<AssetFileInfo[]> {
  const out: AssetFileInfo[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (!IMAGE_EXT.test(entry.name) && !AUDIO_EXT.test(entry.name) && !MAP_EXT.test(entry.name)) {
        continue;
      }
      const stat = await fs.stat(path.join(root, rel));
      out.push({ rel: toPosix(rel), bytes: stat.size, modified: stat.mtimeMs });
    }
  };
  await walk(assetDir);
  return out;
}

/** Everything the renderer needs to open a project, or null when the folder is not there. */
export async function readProjectFiles(root: string): Promise<ProjectFiles | null> {
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  const paths = await projectPaths(root);
  return {
    root,
    manifest: await readIfExists(path.join(root, MANIFEST)),
    config: await readIfExists(path.join(root, CONFIG)),
    scenes: await readDirFiles(root, paths.scenes, /\.scene\.json$/),
    prefabs: await readDirFiles(root, paths.prefabs, /\.prefab\.json$/),
    assets: await listAssets(root, paths.assets),
    occupied: await isOccupied(root, paths),
  };
}

export const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/i;
/** Source files are read whole for the index; anything huge is not source. */
export const MAX_SCRIPT_BYTES = 512 * 1024;
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"]);

/**
 * Every source file under src/, read whole.
 *
 * The main process stays dumb here too: it does not know what a script is, it
 * just hands the renderer the text. Parsing, and deciding which classes are
 * script components, happens above the platform seam where the browser build
 * would do it as well.
 */
export async function listScripts(root: string, srcDir: string): Promise<ScriptFileIpc[]> {
  const out: ScriptFileIpc[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(rel);
        continue;
      }
      if (!SCRIPT_EXT.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const abs = path.join(root, rel);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || stat.size > MAX_SCRIPT_BYTES) continue;
      const contents = await readIfExists(abs);
      if (contents !== null) out.push({ rel: toPosix(rel), contents, modified: stat.mtimeMs });
    }
  };
  await walk(srcDir);

  // Nothing under the configured source root usually means the project does not
  // have one. A folder Mosaic scaffolded keeps its code in `src/`; a project
  // that predates Mosaic frequently keeps it loose at the root, and the Phaser
  // examples all do. Assuming `src/` there indexed zero files — which left the
  // Scripts panel empty and, worse, gave the importer no classes to bind an
  // object to, so an imported scene silently had no behaviour attached.
  //
  // Falling back rather than changing the default keeps a Mosaic project's
  // index exactly as it was: its `src/` is never empty.
  if (!out.length && srcDir !== ".") await walk(".");

  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}
