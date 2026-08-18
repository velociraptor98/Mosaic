import type { MosaicApi } from "../../../electron/contract";
import type { AssetDef } from "../../shared/types";
import { uid } from "../store/ids";
import type {
  Platform,
  ProjectChange,
  ProjectLocation,
  ProjectSource,
  WriteOutcome,
} from "./types";

/**
 * The desktop adapter. Every call is a thin hop onto the preload bridge; no
 * Node reaches the renderer.
 */

export function electronApi(): MosaicApi | null {
  const api = (window as unknown as { mosaic?: MosaicApi }).mosaic;
  return api?.isElectron ? api : null;
}

function encodeRoot(root: string): string {
  // base64url, matching the main process's decoder.
  const bytes = new TextEncoder().encode(root);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function assetKeyFor(rel: string): string {
  return (
    rel
      .replace(/^assets\//, "")
      .replace(/\.\w+$/, "")
      .replace(/[^\w]+/g, "_") || "asset"
  );
}

function kindFor(rel: string): AssetDef["kind"] {
  if (/\.(mp3|ogg|wav|m4a)$/i.test(rel)) return "audio";
  if (/tile(set|s)?[-_.]|[-_.]tiles?\./i.test(rel)) return "tileset";
  if (/(sheet|sprites?|atlas|anim)/i.test(rel)) return "spritesheet";
  return "image";
}

export function createElectronPlatform(api: MosaicApi): Platform {
  return {
    kind: "electron",
    os: api.platform,
    canOpenProjects: true,
    canWatch: true,
    canGit: true,

    pickProject: () => api.pickFolder() as Promise<ProjectLocation | null>,
    createProject: () => api.createFolder() as Promise<ProjectLocation | null>,

    async readProject(root: string): Promise<ProjectSource | null> {
      const files = await api.readProjectFiles(root);
      if (!files) return null;
      return {
        root: files.root,
        manifest: files.manifest,
        config: files.config,
        scenes: files.scenes,
        prefabs: files.prefabs,
        assets: files.assets,
      };
    },

    async writeFiles(root, files): Promise<WriteOutcome> {
      return api.writeFiles(root, files);
    },

    readText: (root, rel) => api.readText(root, rel),

    async importAssets(root: string): Promise<AssetDef[]> {
      return toAssetDefs(root, await api.importAssets(root));
    },

    async copyAssets(root: string, sourcePaths: string[]): Promise<AssetDef[]> {
      return toAssetDefs(root, await api.copyAssets(root, sourcePaths));
    },

    pathForFile: (file: File) => api.pathForFile(file),

    assetUrl(root: string, rel: string): string {
      const path = rel.split("/").map(encodeURIComponent).join("/");
      return `mosaic://asset/${encodeRoot(root)}/${path}`;
    },

    watch(root: string, onChange: (changes: ProjectChange[]) => void): () => void {
      void api.watch(root);
      const off = api.onProjectChanged((changes) => {
        const mine = changes.filter((c) => c.root === root);
        if (mine.length) onChange(mine.map(({ rel, kind }) => ({ rel, kind })));
      });
      return () => {
        off();
        void api.unwatch(root);
      };
    },

    pickDirectory: (defaultPath) => api.pickDirectory(defaultPath),
    defaultProjectsDir: () => api.defaultProjectsDir(),
    validateTarget: (parent, slug) => api.validateTarget(parent, slug),
    toolchain: () => api.toolchain(),
    scaffoldProject: (root, files) => api.createProject(root, files),
    gitInit: (root) => api.gitInit(root),
    install: (root) => api.install(root),
    onInstallProgress: (listener) => api.onInstallProgress(listener),

    gitStatus: (root) => api.gitStatus(root),
    remember: (location) => api.remember(location),
    recents: () => api.recents(),
    forget: (root) => api.forget(root),
    reveal: (root, rel) => api.revealInFolder(root, rel),
    setWindowTitle: (title) => {
      document.title = title;
      void api.setTitle(title);
    },
  };

  function toAssetDefs(root: string, files: { rel: string }[]): AssetDef[] {
    return files.map((file) => ({
      id: uid("asset"),
      key: assetKeyFor(file.rel),
      kind: kindFor(file.rel),
      path: file.rel,
      url: `mosaic://asset/${encodeRoot(root)}/${file.rel
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      width: 0,
      height: 0,
    }));
  }
}
