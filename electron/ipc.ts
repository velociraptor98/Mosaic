import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import {
  CHANGE_CHANNEL,
  IPC,
  type AssetFileInfo,
  type FileChange,
  type GitStatus,
  type ProjectFiles,
  type ProjectFolder,
  type RecentProject,
  type WriteRequest,
  type WriteResultIpc,
} from "./contract";

const execFileAsync = promisify(execFile);

const MANIFEST = "phaser.editor.json";
const SCENE_DIR = "src/scenes";
const PREFAB_DIR = "src/prefabs";
const ASSET_DIR = "assets";
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a)$/i;

const watchers = new Map<string, FSWatcher>();

/**
 * Every path crossing IPC is resolved against the project root and rejected if
 * it escapes. A compromised renderer must not be able to read or write outside
 * the folder the user actually opened.
 */
function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const bounded = path.resolve(root);
  if (abs !== bounded && !abs.startsWith(bounded + path.sep)) {
    throw new Error(`Path escapes the project root: ${rel}`);
  }
  return abs;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------- recents

function recentsFile(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

async function readRecents(): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(recentsFile(), "utf8");
    const parsed = JSON.parse(raw) as RecentProject[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function rememberRecent(folder: ProjectFolder): Promise<void> {
  const list = (await readRecents()).filter((r) => r.root !== folder.root);
  list.unshift({ ...folder, lastOpened: Date.now() });
  try {
    await fs.writeFile(recentsFile(), JSON.stringify(list.slice(0, 12), null, 2));
  } catch {
    /* recents are a convenience, never a hard failure */
  }
}

// ------------------------------------------------------------ file reading

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function readDirFiles(
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

async function listAssets(root: string): Promise<AssetFileInfo[]> {
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
      if (!IMAGE_EXT.test(entry.name) && !AUDIO_EXT.test(entry.name)) continue;
      const stat = await fs.stat(path.join(root, rel));
      out.push({ rel: toPosix(rel), bytes: stat.size, modified: stat.mtimeMs });
    }
  };
  await walk(ASSET_DIR);
  return out;
}

// -------------------------------------------------------------------- git

async function gitStatus(root: string): Promise<GitStatus> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root, timeout: 5000 },
    );
    const status: GitStatus = {};
    for (const line of stdout.split("\n")) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2).trim();
      // Renames read "R  old -> new"; the new path is the one on disk.
      const file = line.slice(3).split(" -> ").pop()!.trim().replace(/^"|"$/g, "");
      status[file] = code;
    }
    return status;
  } catch {
    // Not a repo, or no git on PATH. The Project panel just shows no badges.
    return {};
  }
}

// --------------------------------------------------------------- handlers

export function registerIpc(): void {
  ipcMain.handle(IPC.pickFolder, async (): Promise<ProjectFolder | null> => {
    const result = await dialog.showOpenDialog({
      title: "Open project folder",
      properties: ["openDirectory"],
      buttonLabel: "Open project",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    const folder = { root, name: path.basename(root) };
    await rememberRecent(folder);
    return folder;
  });

  ipcMain.handle(IPC.createFolder, async (): Promise<ProjectFolder | null> => {
    const result = await dialog.showSaveDialog({
      title: "New Mosaic project",
      buttonLabel: "Create project",
      nameFieldLabel: "Project folder",
      defaultPath: path.join(app.getPath("documents"), "my-game"),
      properties: ["createDirectory"],
    });
    if (result.canceled || !result.filePath) return null;
    const root = result.filePath;
    await fs.mkdir(path.join(root, SCENE_DIR), { recursive: true });
    await fs.mkdir(path.join(root, ASSET_DIR), { recursive: true });
    const folder = { root, name: path.basename(root) };
    await rememberRecent(folder);
    return folder;
  });

  ipcMain.handle(
    IPC.readProjectFiles,
    async (_e, root: string): Promise<ProjectFiles | null> => {
      try {
        await fs.access(root);
      } catch {
        return null;
      }
      return {
        root,
        manifest: await readIfExists(path.join(root, MANIFEST)),
        scenes: await readDirFiles(root, SCENE_DIR, /\.scene\.json$/),
        prefabs: await readDirFiles(root, PREFAB_DIR, /\.prefab\.json$/),
        assets: await listAssets(root),
      };
    },
  );

  ipcMain.handle(
    IPC.writeFiles,
    async (_e, root: string, files: WriteRequest[]): Promise<WriteResultIpc> => {
      const result: WriteResultIpc = { written: [], failed: [] };
      for (const file of files) {
        try {
          const abs = resolveInside(root, file.rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, file.contents, "utf8");
          result.written.push(file.rel);
        } catch (err) {
          result.failed.push({ rel: file.rel, error: (err as Error).message });
        }
      }
      return result;
    },
  );

  ipcMain.handle(IPC.readText, async (_e, root: string, rel: string) =>
    readIfExists(resolveInside(root, rel)),
  );

  ipcMain.handle(IPC.importAssets, async (_e, root: string): Promise<AssetFileInfo[]> => {
    const result = await dialog.showOpenDialog({
      title: "Import assets",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Art", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
        { name: "Audio", extensions: ["mp3", "ogg", "wav", "m4a"] },
      ],
    });
    if (result.canceled) return [];
    return copyIntoAssets(root, result.filePaths);
  });

  ipcMain.handle(IPC.copyAssets, async (_e, root: string, sources: string[]) =>
    copyIntoAssets(root, sources),
  );

  ipcMain.handle(IPC.watch, async (_e, root: string) => {
    if (watchers.has(root)) return;
    const watcher = chokidar.watch([MANIFEST, SCENE_DIR, PREFAB_DIR, ASSET_DIR], {
      cwd: root,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    });
    // Coalesce bursts: a single save from an editor can fire several events.
    let pending: FileChange[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(CHANGE_CHANNEL, batch);
      }
    };
    const push = (kind: FileChange["kind"]) => (rel: string) => {
      pending.push({ root, rel: toPosix(rel), kind });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 250);
    };
    watcher.on("add", push("add")).on("change", push("change")).on("unlink", push("unlink"));
    watchers.set(root, watcher);
  });

  ipcMain.handle(IPC.unwatch, async (_e, root: string) => {
    const watcher = watchers.get(root);
    if (!watcher) return;
    watchers.delete(root);
    await watcher.close();
  });

  ipcMain.handle(IPC.gitStatus, async (_e, root: string) => gitStatus(root));
  ipcMain.handle(IPC.recents, async () => readRecents());
  ipcMain.handle(IPC.forget, async (_e, root: string) => {
    const list = (await readRecents()).filter((r) => r.root !== root);
    await fs.writeFile(recentsFile(), JSON.stringify(list, null, 2));
  });

  ipcMain.handle(IPC.revealInFolder, async (_e, root: string, rel?: string) => {
    shell.showItemInFolder(rel ? resolveInside(root, rel) : root);
  });

  ipcMain.handle(IPC.setTitle, async (event, title: string) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
  });

  app.on("will-quit", () => {
    for (const watcher of watchers.values()) void watcher.close();
    watchers.clear();
  });
}

/** Files are copied INTO the project, never referenced from outside it. */
async function copyIntoAssets(root: string, sources: string[]): Promise<AssetFileInfo[]> {
  const dir = path.join(root, ASSET_DIR);
  await fs.mkdir(dir, { recursive: true });
  const out: AssetFileInfo[] = [];
  for (const source of sources) {
    const base = path.basename(source);
    let target = path.join(dir, base);
    let n = 2;
    while (await exists(target)) {
      const ext = path.extname(base);
      target = path.join(dir, `${path.basename(base, ext)}-${n++}${ext}`);
    }
    await fs.copyFile(source, target);
    const stat = await fs.stat(target);
    out.push({
      rel: toPosix(path.relative(root, target)),
      bytes: stat.size,
      modified: stat.mtimeMs,
    });
  }
  return out;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
