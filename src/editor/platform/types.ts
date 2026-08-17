import type { AssetDef } from "../../shared/types";

/**
 * The one seam between Mosaic and the machine it runs on.
 *
 * The desktop build talks to a real filesystem, a watcher and git; the browser
 * build keeps its localStorage + download model. Everything above this
 * interface — the store, the canvas, every panel — is identical on both.
 */

export interface ProjectLocation {
  /** Absolute folder path on desktop; a synthetic id in the browser. */
  root: string;
  name: string;
}

export interface RecentEntry extends ProjectLocation {
  lastOpened: number;
}

export interface DiskFile {
  /** Project-relative POSIX path. */
  rel: string;
  contents: string;
}

export interface DiskAsset {
  rel: string;
  bytes: number;
  modified: number;
}

export interface ProjectSource {
  root: string;
  /** phaser.editor.json, or null for a folder Mosaic has not written yet. */
  manifest: string | null;
  scenes: DiskFile[];
  prefabs: DiskFile[];
  assets: DiskAsset[];
}

export interface WriteOutcome {
  written: string[];
  failed: { rel: string; error: string }[];
}

export type ChangeKind = "add" | "change" | "unlink";

export interface ProjectChange {
  rel: string;
  kind: ChangeKind;
}

export interface Platform {
  readonly kind: "browser" | "electron";
  /** True when the platform can open a real project folder on disk. */
  readonly canOpenProjects: boolean;
  /** True when the platform watches the folder for external edits. */
  readonly canWatch: boolean;
  readonly canGit: boolean;

  pickProject(): Promise<ProjectLocation | null>;
  createProject(): Promise<ProjectLocation | null>;
  readProject(root: string): Promise<ProjectSource | null>;
  writeFiles(root: string, files: DiskFile[]): Promise<WriteOutcome>;
  readText(root: string, rel: string): Promise<string | null>;

  /** Native picker on desktop; copies the chosen files into assets/. */
  importAssets(root: string): Promise<AssetDef[]>;
  /** Copy already-known paths (drag & drop) into assets/. */
  copyAssets(root: string, sourcePaths: string[]): Promise<AssetDef[]>;
  /** Absolute path of a dropped File, or "" when the platform cannot say. */
  pathForFile(file: File): string;
  /** How the renderer and Phaser should fetch an asset's bytes. */
  assetUrl(root: string, rel: string): string;

  watch(root: string, onChange: (changes: ProjectChange[]) => void): () => void;
  gitStatus(root: string): Promise<Record<string, string>>;

  recents(): Promise<RecentEntry[]>;
  forget(root: string): Promise<void>;
  reveal(root: string, rel?: string): Promise<void>;
  setWindowTitle(title: string): void;
}
