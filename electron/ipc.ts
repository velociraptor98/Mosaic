import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs, { constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { bundleScripts } from "./bundleScripts";
import { spawn } from "node:child_process";
import os from "node:os";
import {
  CHANGE_CHANNEL,
  INSTALL_CHANNEL,
  IPC,
  type AssetFileInfo,
  type FileChange,
  type GitStatus,
  type ProjectFiles,
  type ProjectFolder,
  type RecentProject,
  type CreateResult,
  type EditorOpen,
  type ScriptBundle,
  type ScriptEntry,
  type ScriptFileIpc,
  type InstallProgress,
  type TargetCheck,
  type Toolchain,
  type WriteRequest,
  type WriteResultIpc,
} from "./contract";

const execFileAsync = promisify(execFile);

const MANIFEST = "phaser.editor.json";
const CONFIG = "mosaic.config.json";
const SCENE_DIR = "src/scenes";
const SRC_DIR = "src";
const PREFAB_DIR = "src/prefabs";
const ASSET_DIR = "assets";
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a)$/i;
const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/i;
/** Source files are read whole for the index; anything huge is not source. */
const MAX_SCRIPT_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"]);

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

/**
 * Every source file under src/, read whole.
 *
 * The main process stays dumb here too: it does not know what a script is, it
 * just hands the renderer the text. Parsing, and deciding which classes are
 * script components, happens above the platform seam where the browser build
 * would do it as well.
 */
async function listScripts(root: string): Promise<ScriptFileIpc[]> {
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
  await walk(SRC_DIR);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * Hands a file to the user's real editor. Mosaic shows source read-only, so
 * this is the one door out to editing it — the configured editor first, then
 * whatever the OS has registered, and never a silent no-op.
 */
async function openInEditor(root: string, rel: string, line?: number): Promise<EditorOpen> {
  let abs: string;
  try {
    abs = resolveInside(root, rel);
  } catch (err) {
    return { ok: false, via: "none", error: (err as Error).message };
  }
  if (!(await exists(abs))) return { ok: false, via: "none", error: `${rel} is not on disk` };

  const target = line && line > 0 ? `${abs}:${line}` : abs;
  const configured = process.env.MOSAIC_EDITOR?.trim();
  const candidates: { cmd: string; args: string[] }[] = [];
  if (configured) candidates.push({ cmd: configured, args: ["-g", target] });
  candidates.push(
    { cmd: "code", args: ["-g", target] },
    { cmd: "cursor", args: ["-g", target] },
    { cmd: "subl", args: [target] },
  );

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.cmd, candidate.args, {
        timeout: 5000,
        shell: process.platform === "win32",
      });
      return { ok: true, via: "editor" };
    } catch {
      // Not installed, or not on PATH. Try the next one.
    }
  }

  // No code editor: the OS handler at least opens the file, minus the line.
  const error = await shell.openPath(abs);
  return error ? { ok: false, via: "none", error } : { ok: true, via: "system" };
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
    // The recent entry is recorded when the project actually opens, not here.
    return { root, name: path.basename(root) };
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
    return { root, name: path.basename(root) };
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
        config: await readIfExists(path.join(root, CONFIG)),
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
          await writeOne(abs, file);
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

  ipcMain.handle(IPC.readScripts, async (_e, root: string): Promise<ScriptFileIpc[]> =>
    listScripts(root),
  );

  ipcMain.handle(IPC.openInEditor, async (_e, root: string, rel: string, line?: number) =>
    openInEditor(root, rel, line),
  );

  ipcMain.handle(
    IPC.bundleScripts,
    async (_e, root: string, entries: ScriptEntry[]): Promise<ScriptBundle> => {
      // Every entry is resolved against the root before it reaches the
      // bundler, so a renderer cannot ask for a file outside the project.
      for (const entry of entries) resolveInside(root, entry.src);
      return bundleScripts(root, entries);
    },
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
    // src/ rather than src/scenes: scripts live beside the scenes they are
    // attached in, and an edit to one has to re-index as promptly as an edit
    // to the other reloads.
    const watcher = chokidar.watch([MANIFEST, CONFIG, SRC_DIR, PREFAB_DIR, ASSET_DIR], {
      cwd: root,
      ignoreInitial: true,
      ignored: (p: string) => SKIP_DIRS.has(path.basename(p)),
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
  ipcMain.handle(IPC.remember, async (_e, folder: ProjectFolder) => rememberRecent(folder));

  ipcMain.handle(IPC.recents, async (): Promise<RecentProject[]> => {
    const list = await readRecents();
    return Promise.all(
      list.map(async (entry) => {
        const stat = await fs.stat(entry.root).catch(() => null);
        if (!stat?.isDirectory()) return { ...entry, missing: true };
        const scenes = await fs
          .readdir(path.join(entry.root, SCENE_DIR))
          .catch(() => [] as string[]);
        let phaser: string | null = null;
        const pkg = await readIfExists(path.join(entry.root, "package.json"));
        if (pkg) {
          try {
            const parsed = JSON.parse(pkg);
            phaser = parsed.dependencies?.phaser ?? parsed.devDependencies?.phaser ?? null;
          } catch {
            /* an unreadable package.json just means no version badge */
          }
        }
        return {
          ...entry,
          missing: false,
          scenes: scenes.filter((f) => f.endsWith(".scene.json")).length,
          phaser,
        };
      }),
    );
  });
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

  ipcMain.handle(IPC.pickDirectory, async (_e, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: "Choose a location",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Choose",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.defaultProjectsDir, async () => {
    // ~/dev when it exists, because that is where most people keep code.
    const dev = path.join(os.homedir(), "dev");
    try {
      const stat = await fs.stat(dev);
      if (stat.isDirectory()) return dev;
    } catch {
      /* fall through */
    }
    return app.getPath("documents");
  });

  /**
   * Everything the details screen needs to show BEFORE the folder exists:
   * whether the parent is writable, whether the target is free, and whether a
   * project is already sitting there.
   */
  ipcMain.handle(
    IPC.validateTarget,
    async (_e, parent: string, slug: string): Promise<TargetCheck> => {
      const resolved = path.resolve(parent || os.homedir(), slug);
      const check: TargetCheck = {
        resolved,
        exists: false,
        isEmpty: true,
        writable: false,
        hasProject: false,
      };
      try {
        // Writability is a property of the nearest existing ancestor.
        let probe = resolved;
        for (;;) {
          try {
            await fs.access(probe, fsConstants.W_OK);
            check.writable = true;
            break;
          } catch {
            const up = path.dirname(probe);
            if (up === probe) break;
            probe = up;
          }
        }
        const stat = await fs.stat(resolved).catch(() => null);
        if (stat?.isDirectory()) {
          check.exists = true;
          const entries = await fs.readdir(resolved);
          check.isEmpty = entries.filter((n) => n !== ".DS_Store").length === 0;
          check.hasProject = entries.includes(MANIFEST) || entries.includes(CONFIG);
        } else if (stat) {
          check.exists = true;
          check.isEmpty = false;
          check.error = "A file already exists at that path";
        }
      } catch (err) {
        check.error = (err as Error).message;
      }
      return check;
    },
  );

  ipcMain.handle(IPC.toolchain, async (): Promise<Toolchain> => ({
    node: await which("node", ["--version"]),
    npm: await which("npm", ["--version"]),
    git: await which("git", ["--version"]),
  }));

  /**
   * Transactional create: on any failure the folder is rolled back to what it
   * was, so cancelling or crashing leaves nothing behind.
   */
  ipcMain.handle(
    IPC.createProject,
    async (_e, root: string, files: WriteRequest[]): Promise<CreateResult> => {
      const existedBefore = await fs
        .stat(root)
        .then((s) => s.isDirectory())
        .catch(() => false);
      const written: string[] = [];
      try {
        await fs.mkdir(root, { recursive: true });
        for (const file of files) {
          const abs = resolveInside(root, file.rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          if (await exists(abs)) {
            throw new Error(`Refusing to overwrite ${file.rel}`);
          }
          await writeOne(abs, file);
          written.push(file.rel);
        }
        return { ok: true, root, written };
      } catch (err) {
        // Roll back: remove what we wrote, and the folder itself if we made it.
        for (const rel of written.reverse()) {
          await fs.rm(path.resolve(root, rel), { force: true }).catch(() => {});
        }
        if (!existedBefore) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        return { ok: false, root, written: [], error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC.gitInit, async (_e, root: string) => {
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: root, timeout: 10000 });
      await execFileAsync("git", ["add", "-A"], { cwd: root, timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  });

  /**
   * Install runs in the background: scaffolding is fast, install is not, and
   * the editor should open on the scene rather than hold a modal for minutes.
   */
  ipcMain.handle(IPC.install, async (event, root: string) => {
    const send = (payload: InstallProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send(INSTALL_CHANNEL, payload);
    };
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    let child;
    try {
      child = spawn(npm, ["install"], { cwd: root, shell: process.platform === "win32" });
    } catch (err) {
      send({ root, done: true, code: null, error: (err as Error).message });
      return;
    }
    child.stdout?.on("data", (d) => send({ root, chunk: String(d) }));
    child.stderr?.on("data", (d) => send({ root, chunk: String(d) }));
    child.on("error", (err) => send({ root, done: true, code: null, error: err.message }));
    child.on("close", (code) => send({ root, done: true, code }));
  });

  app.on("will-quit", () => {
    for (const watcher of watchers.values()) void watcher.close();
    watchers.clear();
  });
}

async function writeOne(abs: string, file: WriteRequest): Promise<void> {
  if (file.encoding === "base64") {
    await fs.writeFile(abs, Buffer.from(file.contents, "base64"));
  } else {
    await fs.writeFile(abs, file.contents, "utf8");
  }
}

async function which(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 4000 });
    return stdout.trim();
  } catch {
    return null;
  }
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
