import { contextBridge, ipcRenderer, webUtils } from "electron";
import { CHANGE_CHANNEL, IPC, type FileChange, type MosaicApi } from "./contract";

/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * typed call onto a channel in the contract — no module handles, no `require`,
 * no ipcRenderer itself.
 */
const api: MosaicApi = {
  isElectron: true,
  platform: process.platform,
  version: process.versions.electron ?? "",

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  createFolder: () => ipcRenderer.invoke(IPC.createFolder),
  readProjectFiles: (root) => ipcRenderer.invoke(IPC.readProjectFiles, root),
  writeFiles: (root, files) => ipcRenderer.invoke(IPC.writeFiles, root, files),
  readText: (root, rel) => ipcRenderer.invoke(IPC.readText, root, rel),
  importAssets: (root) => ipcRenderer.invoke(IPC.importAssets, root),
  copyAssets: (root, sources) => ipcRenderer.invoke(IPC.copyAssets, root, sources),

  watch: (root) => ipcRenderer.invoke(IPC.watch, root),
  unwatch: (root) => ipcRenderer.invoke(IPC.unwatch, root),
  onProjectChanged: (listener: (changes: FileChange[]) => void) => {
    const handler = (_e: unknown, changes: FileChange[]) => listener(changes);
    ipcRenderer.on(CHANGE_CHANNEL, handler);
    return () => {
      ipcRenderer.off(CHANGE_CHANNEL, handler);
    };
  },

  // Electron 32 removed File.path; this is the supported replacement, and it
  // is what lets drag & drop copy real files into assets/.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  gitStatus: (root) => ipcRenderer.invoke(IPC.gitStatus, root),
  recents: () => ipcRenderer.invoke(IPC.recents),
  forget: (root) => ipcRenderer.invoke(IPC.forget, root),
  revealInFolder: (root, rel) => ipcRenderer.invoke(IPC.revealInFolder, root, rel),
  setTitle: (title) => ipcRenderer.invoke(IPC.setTitle, title),
};

contextBridge.exposeInMainWorld("mosaic", api);
