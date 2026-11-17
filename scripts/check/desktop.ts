import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { MosaicApi, WriteRequest } from "../../electron/contract";
import { findGameEntries } from "../../electron/existingProject";
import { analyzeClass } from "../../electron/classShape";
import { listScripts, projectPaths, readIfExists, readProjectFiles } from "../../electron/projectFiles";

/**
 * The desktop app's bridge, in plain Node, for `npm run check`.
 *
 * The editor picks its platform when it loads: with `window.mosaic` present it
 * is the desktop app. So this module, imported before any editor code, puts a
 * `window.mosaic` there whose reads are the main process's own (shared from
 * electron/projectFiles.ts) and whose writes are only recorded. Everything
 * above it — the Workspace, the store, the generator — is the real thing.
 */

export interface Recorded {
  writes: WriteRequest[];
  removed: string[];
  /**
   * When set, writes under this folder land on disk as well as being
   * recorded. Only ever a scratch copy: the adoption check needs to reopen
   * what it wrote, and the samples must never be touched.
   */
  passthrough: string | null;
}

export const recorded: Recorded = { writes: [], removed: [], passthrough: null };

const handled: Partial<MosaicApi> = {
  isElectron: true,
  platform: process.platform as MosaicApi["platform"],
  readProjectFiles: (root) => readProjectFiles(root),
  readText: (root, rel) => readIfExists(path.join(root, rel)),
  readScripts: async (root) => listScripts(root, (await projectPaths(root)).src),
  async writeFiles(root, files) {
    recorded.writes.push(...files);
    if (recorded.passthrough && path.resolve(root) === path.resolve(recorded.passthrough)) {
      for (const file of files) {
        const abs = path.join(root, file.rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, file.contents, file.encoding === "base64" ? "base64" : "utf8");
      }
    }
    return { written: files.map((f) => f.rel), failed: [] };
  },
  async removeFiles(_root, rels) {
    recorded.removed.push(...rels);
    return [];
  },
  watch: async () => {},
  unwatch: async () => {},
  onProjectChanged: () => () => {},
  onInstallProgress: () => () => {},
  gitStatus: async () => ({}),
  findGameEntries: (root) => findGameEntries(root),
  analyzeClass: (root, rel, cls) => analyzeClass(path.resolve(root), rel, cls),
  remember: async () => {},
  recents: async () => [],
  setTitle: async () => {},
};

/** Anything else the editor reaches for is a surprise worth hearing about. */
const api = new Proxy(handled, {
  get(target, key: string) {
    if (key in target) return target[key as keyof MosaicApi];
    return () => {
      throw new Error(`check: the editor called window.mosaic.${key}, which the check does not provide`);
    };
  },
}) as MosaicApi;

/**
 * Art found on disk is measured by loading it as an image. Node has no
 * images, so it fails the way an unreadable file does and the size stays 0 —
 * which is what the editor shows for one it could not read, too. The samples
 * never got here: their manifests already carry every size.
 */
class UnmeasurableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_url: string) {
    setTimeout(() => this.onerror?.(), 0);
  }
}

const memory = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  Image: UnmeasurableImage,
  mosaic: api,
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
});
