import type { AssetDef } from "../../shared/types";
import type {
  CreateResult,
  Platform,
  ProjectLocation,
  ProjectSource,
  TargetCheck,
  Toolchain,
  WriteOutcome,
} from "./types";

/**
 * The browser build keeps the model it has always had: the project lives in
 * localStorage, assets are inlined as data: URLs, and files leave through the
 * export dialog. Opening a folder, watching it and reading git all need a real
 * filesystem, so they are reported as unavailable rather than faked.
 */
export const browserPlatform: Platform = {
  kind: "browser",
  os: "",
  canOpenProjects: false,
  canWatch: false,
  canGit: false,

  async pickProject(): Promise<ProjectLocation | null> {
    return null;
  },
  async createProject(): Promise<ProjectLocation | null> {
    return null;
  },
  async readProject(): Promise<ProjectSource | null> {
    return null;
  },
  async writeFiles(): Promise<WriteOutcome> {
    return { written: [], failed: [] };
  },
  async readText(): Promise<string | null> {
    return null;
  },
  async importAssets(): Promise<AssetDef[]> {
    return [];
  },
  async copyAssets(): Promise<AssetDef[]> {
    return [];
  },
  pathForFile(): string {
    return ""; // the browser never sees a real path, and must not pretend to
  },
  assetUrl(_root: string, rel: string): string {
    // In the browser an asset's bytes already travel with it as a data: URL;
    // the relative path is only ever a label.
    return rel;
  },
  watch(): () => void {
    return () => {};
  },
  async gitStatus(): Promise<Record<string, string>> {
    return {};
  },
  // The New Project flow needs a filesystem; the browser build reports it as
  // unavailable rather than half-implementing it.
  async pickDirectory(): Promise<string | null> {
    return null;
  },
  async defaultProjectsDir(): Promise<string> {
    return "";
  },
  async validateTarget(): Promise<TargetCheck> {
    return { resolved: "", exists: false, isEmpty: true, writable: false, hasProject: false };
  },
  async toolchain(): Promise<Toolchain> {
    return { node: null, npm: null, git: null };
  },
  async scaffoldProject(): Promise<CreateResult> {
    return { ok: false, root: "", written: [], error: "Not available in the browser" };
  },
  async gitInit(): Promise<boolean> {
    return false;
  },
  async install(): Promise<void> {},
  onInstallProgress(): () => void {
    return () => {};
  },

  async remember(): Promise<void> {},
  async recents() {
    return [];
  },
  async forget(): Promise<void> {},
  async reveal(): Promise<void> {},
  setWindowTitle(title: string): void {
    document.title = title;
  },
};
