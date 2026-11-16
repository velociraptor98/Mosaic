import path from "node:path";

import type { MosaicApi, WriteRequest } from "../../electron/contract";
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
}

export const recorded: Recorded = { writes: [], removed: [] };

const handled: Partial<MosaicApi> = {
  isElectron: true,
  platform: process.platform as MosaicApi["platform"],
  readProjectFiles: (root) => readProjectFiles(root),
  readText: (root, rel) => readIfExists(path.join(root, rel)),
  readScripts: async (root) => listScripts(root, (await projectPaths(root)).src),
  async writeFiles(_root, files) {
    recorded.writes.push(...files);
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
  findGameEntries: async () => [],
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

const memory = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  mosaic: api,
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
});
