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
  importAssets: "mosaic:importAssets",
  copyAssets: "mosaic:copyAssets",
  watch: "mosaic:watch",
  unwatch: "mosaic:unwatch",
  gitStatus: "mosaic:gitStatus",
  recents: "mosaic:recents",
  forget: "mosaic:forget",
  revealInFolder: "mosaic:revealInFolder",
  setTitle: "mosaic:setTitle",
} as const;

/** Pushed from main -> renderer when watched files change on disk. */
export const CHANGE_CHANNEL = "mosaic:projectChanged";

export interface ProjectFolder {
  root: string;
  name: string;
}

export interface RecentProject extends ProjectFolder {
  lastOpened: number;
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
  scenes: { rel: string; contents: string }[];
  prefabs: { rel: string; contents: string }[];
  assets: AssetFileInfo[];
}

export interface WriteRequest {
  rel: string;
  contents: string;
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
  importAssets(root: string): Promise<AssetFileInfo[]>;
  copyAssets(root: string, sourcePaths: string[]): Promise<AssetFileInfo[]>;

  watch(root: string): Promise<void>;
  unwatch(root: string): Promise<void>;
  onProjectChanged(listener: (changes: FileChange[]) => void): () => void;

  /** Absolute path of a dropped File. Empty string when unavailable. */
  pathForFile(file: File): string;

  gitStatus(root: string): Promise<GitStatus>;
  recents(): Promise<RecentProject[]>;
  forget(root: string): Promise<void>;
  revealInFolder(root: string, rel?: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}
