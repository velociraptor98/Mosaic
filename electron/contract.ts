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
  removeFiles: "mosaic:removeFiles",
  readText: "mosaic:readText",
  readScripts: "mosaic:readScripts",
  openInEditor: "mosaic:openInEditor",
  openInTiled: "mosaic:openInTiled",
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
  analyzeClass: "mosaic:analyzeClass",
  devServerStart: "mosaic:devServerStart",
  devServerStop: "mosaic:devServerStop",
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
  /**
   * What the folder already is, when Mosaic has never written to it and it
   * holds a Phaser game. Absent for a Mosaic project and for a folder with no
   * sign of Phaser in it.
   */
  existing?: ExistingProject | null;
}

/** A Phaser game Mosaic did not make, as read off disk before anything is written. */
export interface ExistingProject {
  /** The version range declared, e.g. "^3.90.0"; null when nothing declares one. */
  phaser: string | null;
  phaserFrom: "package.json" | "bower.json" | null;
  /** 2, 3, 4… from the declaration, else from what the code looks like. */
  major: number | null;
  /** Files that start the game, best first. */
  entries: string[];
  /** Where this project keeps things, where that differs from Mosaic's defaults. */
  paths: {
    src?: string;
    scenes?: string;
    prefabs?: string;
    assets?: string;
    publicDir?: string;
  };
  /** The game config's canvas size, when it states one in plain numbers. */
  canvas: { width: number; height: number } | null;
  /** The physics the game config turns on. A game that names none has none. */
  physics: "arcade" | "matter" | "none";
  /** Whether the game config asks for pixel-art rendering. */
  pixelArt: boolean;
  /** The game config's background colour, as #rrggbb, when it states one. */
  backgroundColor: string | null;
  /** What the game is written in, from the file that starts it. */
  language: "ts" | "js";
  /** "global" when no file imports Phaser: it comes from a script tag. */
  phaserAccess: "module" | "global";
}

/** One source file of the project, as read for the script index. */
export interface ScriptFileIpc {
  /** Project-relative POSIX path, e.g. "src/scripts/PlayerController.ts". */
  rel: string;
  contents: string;
  modified: number;
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

/** What happened when RUN asked for the project's dev server. */
export interface DevServerResult {
  ok: boolean;
  /** Where the game is being served, e.g. "http://localhost:5173/". */
  url?: string;
  /** Why it is not, in a form the UI can act on rather than only show. */
  code?: "no-package" | "no-script" | "not-installed" | "exited" | "timeout" | "spawn";
  error?: string;
  /** The tail of what the server printed. */
  log: string;
  /** The package.json script that was run. */
  script?: string;
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

/** A method of a scene class, by offset into the source it was parsed from. */
export interface MethodShape {
  /** Where the method begins, decorators and modifiers included. */
  start: number;
  /** Where its name begins. */
  keyStart: number;
  /** Just inside the opening brace of its body. */
  bodyStart: number;
  /** The closing brace of its body. */
  bodyEnd: number;
  firstStatement: number | null;
  async: boolean;
}

/**
 * A `this.add.<factory>(…)` call that runs exactly once per create(), so the
 * one object it makes can come from the layout instead.
 */
export interface AddCall {
  start: number;
  end: number;
  /** 1-based. */
  line: number;
  factory: string;
  /** Set when the call is a statement of its own, its result unused. */
  statement: { start: number; end: number } | null;
  /** The name the result is kept under: `let sign = …` → "sign", `this.levelImage = …` → "levelImage". */
  binding: string | null;
}

/** What wiring a layout into a scene class needs to know about it. */
export interface ClassShape {
  ok: boolean;
  /** Why it cannot be edited, when it cannot. */
  reason?: string;
  rel: string;
  /** The exact text the offsets are into. */
  source: string;
  /** Whether it is an ES module, which an `import` needs. */
  module: boolean;
  /** End of the last import declaration, or null when it has none. */
  importEnd: number | null;
  classBodyStart: number;
  classBodyEnd: number;
  create: MethodShape | null;
  preload: MethodShape | null;
  calls: AddCall[];
  /** Names declared inside create(), which a new local must not shadow. */
  names: string[];
}

/** Where a game object was made, mapped back to the project's own source. */
export interface SourceSite {
  /** Project-relative POSIX path. */
  src: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  col: number;
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
  /**
   * Deletes files Mosaic itself wrote for a scene or prefab that no longer
   * exists. Anything that is not scene data or a generated layout is refused.
   */
  removeFiles(root: string, rels: string[]): Promise<string[]>;
  readText(root: string, rel: string): Promise<string | null>;
  /** Every source file under src/, for the script index. */
  readScripts(root: string): Promise<ScriptFileIpc[]>;
  /** Opens a map in Tiled, or in whatever the OS has for the file if Tiled is not found. */
  openInTiled(root: string, rel: string): Promise<{ ok: boolean; via: "tiled" | "system" | "none"; error?: string }>;
  /** Opens a project file in the user's own editor, at a line where it can. */
  openInEditor(root: string, rel: string, line?: number): Promise<EditorOpen>;
  /** Files that construct a `Phaser.Game` — the candidate import entries. */
  findGameEntries(root: string): Promise<string[]>;
  /** Runs one of them and reports what its scenes built. */
  recordScene(root: string, entry: string): Promise<SceneRecording>;
  /** Reads one scene class and describes the parts wiring a layout into it edits. */
  analyzeClass(root: string, rel: string, cls: string): Promise<ClassShape>;
  /** Starts the project's own dev server, or returns the one already running. */
  devServerStart(root: string): Promise<DevServerResult>;
  devServerStop(root: string): Promise<void>;
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
 * model, and the main process stays dumb about what a scene means.
 */
export interface SceneRecording {
  ok: boolean;
  error?: string;
  /** Keyed by Phaser scene key. Shape matches the importer's `Recording`. */
  scenes?: Record<string, unknown>;
}
