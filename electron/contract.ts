/**
 * The IPC contract between Mosaic's main process and its renderer.
 *
 * Deliberately dumb: the main process is a filesystem, a watcher and a git
 * client. It knows nothing about scenes, prefabs or the project schema — the
 * renderer parses and validates everything, exactly as the browser build does.
 * That keeps one code path for the data model across both targets.
 */

export const IPC = {
  pickFolder: "mosaic:pickFolder",
  createFolder: "mosaic:createFolder",
  readProjectFiles: "mosaic:readProjectFiles",
  writeFiles: "mosaic:writeFiles",
  readText: "mosaic:readText",
  readScripts: "mosaic:readScripts",
  openInEditor: "mosaic:openInEditor",
  bundleScripts: "mosaic:bundleScripts",
  importAssets: "mosaic:importAssets",
  copyAssets: "mosaic:copyAssets",
  watch: "mosaic:watch",
  unwatch: "mosaic:unwatch",
  gitStatus: "mosaic:gitStatus",
  recents: "mosaic:recents",
  remember: "mosaic:remember",
  forget: "mosaic:forget",
  revealInFolder: "mosaic:revealInFolder",
  setTitle: "mosaic:setTitle",
  pickDirectory: "mosaic:pickDirectory",
  defaultProjectsDir: "mosaic:defaultProjectsDir",
  validateTarget: "mosaic:validateTarget",
  toolchain: "mosaic:toolchain",
  createProject: "mosaic:createProject",
  gitInit: "mosaic:gitInit",
  install: "mosaic:install",
  findGameEntries: "mosaic:findGameEntries",
  recordScene: "mosaic:recordScene",
  bundleEntry: "mosaic:bundleEntry",
  packageGame: "mosaic:packageGame",
} as const;

/** Pushed from main -> renderer when watched files change on disk. */
export const CHANGE_CHANNEL = "mosaic:projectChanged";
/** Pushed while a dependency install runs. */
export const INSTALL_CHANNEL = "mosaic:installProgress";

export interface ProjectFolder {
  root: string;
  name: string;
}

export interface RecentProject extends ProjectFolder {
  lastOpened: number;
  /** Re-validated on show: a missing folder is greyed, never dropped. */
  missing?: boolean;
  scenes?: number;
  phaser?: string | null;
}

export interface AssetFileInfo {
  /** Project-relative POSIX path, e.g. "assets/hero.png". */
  rel: string;
  bytes: number;
  /** Milliseconds since epoch. */
  modified: number;
}

export interface ProjectFiles {
  root: string;
  /** Contents of phaser.editor.json, or null when the folder has none yet. */
  manifest: string | null;
  /** Contents of mosaic.config.json — scene defaults. */
  config: string | null;
  scenes: { rel: string; contents: string }[];
  prefabs: { rel: string; contents: string }[];
  assets: AssetFileInfo[];
  /**
   * The folder already holds something that is not ours.
   *
   * An empty folder is an invitation to scaffold into; somebody's existing
   * repo is not, and the difference is not visible from the four things above
   * — a Phaser project Mosaic cannot read looks exactly like an empty one.
   */
  occupied: boolean;
}

/** One source file of the project, as read for the script index. */
export interface ScriptFileIpc {
  /** Project-relative POSIX path, e.g. "src/scripts/PlayerController.ts". */
  rel: string;
  contents: string;
  modified: number;
}

/** One class the renderer wants compiled into the play-test bundle. */
export interface ScriptEntry {
  /** Project-relative POSIX path. */
  src: string;
  className: string;
  /**
   * The name the module exports it under, when that differs from the class
   * name. `"default"` for `export default class` — the form the Phaser
   * examples use throughout, and one a named import cannot reach.
   */
  exportName?: string;
}

/**
 * A compiled bundle of the project's script classes, as an IIFE that assigns
 * `MosaicScripts` and takes the editor's Phaser instance as `__mosaicPhaser`.
 */
export interface ScriptBundle {
  code: string | null;
  /** Set when the project's code did not compile. */
  error?: string;
  warnings: string[];
  /** Project-relative paths that went into the bundle. */
  modules: string[];
}

/** What happened when the renderer asked to open a file outside Mosaic. */
export interface EditorOpen {
  ok: boolean;
  /** "editor" when a real code editor took it, "system" for the OS handler. */
  via: "editor" | "system" | "none";
  error?: string;
}

export interface WriteRequest {
  rel: string;
  contents: string;
  /** base64 for binary files (art); utf8 by default. */
  encoding?: "utf8" | "base64";
}

/** What the New Project flow can learn about a target folder before writing. */
export interface TargetCheck {
  resolved: string;
  exists: boolean;
  isEmpty: boolean;
  writable: boolean;
  /** Set when the folder already holds a Mosaic project. */
  hasProject: boolean;
  error?: string;
}

export interface Toolchain {
  node: string | null;
  npm: string | null;
  git: string | null;
}

export interface CreateResult {
  ok: boolean;
  root: string;
  written: string[];
  error?: string;
}

export interface InstallProgress {
  root: string;
  chunk?: string;
  done?: boolean;
  code?: number | null;
  error?: string;
}

export interface WriteResultIpc {
  written: string[];
  failed: { rel: string; error: string }[];
}

export type ChangeKind = "add" | "change" | "unlink";

export interface FileChange {
  root: string;
  rel: string;
  kind: ChangeKind;
}

/** What Export game… asks the main process to build. */
export interface PackageRequest {
  root: string;
  /** Project-relative entry point, e.g. "src/main.ts". */
  entry: string;
  /** Project-relative output folder, e.g. "build/web". */
  outDir: string;
  /** Project-relative asset folder, from mosaic.config.json. */
  assetsDir: string;
  minify: boolean;
  copyAssets: boolean;
  /** Also write <outDir>.zip, with index.html at the archive root. */
  zip: boolean;
  /** Used only when the project has no index.html of its own. */
  title: string;
  background: string;
}

export interface PackagedFile {
  rel: string;
  bytes: number;
}

/** Which Phaser was linked in, and whose copy it was. */
export interface PhaserChoice {
  file: string;
  version: string;
  source: "project" | "editor";
}

export interface PackageResult {
  ok: boolean;
  error?: string;
  /** Absolute path of the folder that was written. */
  outDir?: string;
  zipPath?: string;
  ms: number;
  warnings: string[];
  files: PackagedFile[];
  phaser?: PhaserChoice;
  totalBytes: number;
}

/** Porcelain-ish status codes, keyed by project-relative path. */
export type GitStatus = Record<string, string>;

export interface MosaicApi {
  readonly isElectron: true;
  readonly platform: string;
  readonly version: string;

  pickFolder(): Promise<ProjectFolder | null>;
  createFolder(): Promise<ProjectFolder | null>;
  readProjectFiles(root: string): Promise<ProjectFiles | null>;
  writeFiles(root: string, files: WriteRequest[]): Promise<WriteResultIpc>;
  readText(root: string, rel: string): Promise<string | null>;
  /** Every source file under src/, for the script index. */
  readScripts(root: string): Promise<ScriptFileIpc[]>;
  /** Opens a project file in the user's own editor, at a line where it can. */
  openInEditor(root: string, rel: string, line?: number): Promise<EditorOpen>;
  /** Compiles the project's script classes for the play-test. */
  bundleScripts(root: string, entries: ScriptEntry[]): Promise<ScriptBundle>;
  /** Files that construct a `Phaser.Game` — the candidate import entries. */
  findGameEntries(root: string): Promise<string[]>;
  /** Runs one of them and reports what its scenes built. */
  recordScene(root: string, entry: string): Promise<SceneRecording>;
  /** Compiles an entry point so the renderer can run the project's own game. */
  bundleEntry(root: string, entry: string): Promise<{ code: string | null; error?: string }>;
  /** Bundles the whole game into a folder that runs with nothing installed. */
  packageGame(request: PackageRequest): Promise<PackageResult>;
  importAssets(root: string): Promise<AssetFileInfo[]>;
  copyAssets(root: string, sourcePaths: string[]): Promise<AssetFileInfo[]>;

  watch(root: string): Promise<void>;
  unwatch(root: string): Promise<void>;
  onProjectChanged(listener: (changes: FileChange[]) => void): () => void;

  /** Absolute path of a dropped File. Empty string when unavailable. */
  pathForFile(file: File): string;

  pickDirectory(defaultPath?: string): Promise<string | null>;
  defaultProjectsDir(): Promise<string>;
  validateTarget(parent: string, slug: string): Promise<TargetCheck>;
  toolchain(): Promise<Toolchain>;
  /** Transactional: a failure part-way rolls the folder back. */
  createProject(root: string, files: WriteRequest[]): Promise<CreateResult>;
  gitInit(root: string): Promise<boolean>;
  install(root: string): Promise<void>;
  onInstallProgress(listener: (p: InstallProgress) => void): () => void;

  gitStatus(root: string): Promise<GitStatus>;
  remember(folder: ProjectFolder): Promise<void>;
  recents(): Promise<RecentProject[]>;
  forget(root: string): Promise<void>;
  revealInFolder(root: string, rel?: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}

/**
 * One scene, as it existed the moment its `create()` returned.
 *
 * Deliberately untyped beyond this: the renderer owns the mapping into Mosaic's
 * model, and the main process stays dumb about what a scene means — the same
 * split `bundleScripts` already keeps.
 */
export interface SceneRecording {
  ok: boolean;
  error?: string;
  /** Keyed by Phaser scene key. Shape matches the importer's `Recording`. */
  scenes?: Record<string, unknown>;
}
