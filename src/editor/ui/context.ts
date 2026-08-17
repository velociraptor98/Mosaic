import { createContext, useContext, useSyncExternalStore } from "react";
import type { EditorBridge } from "../bridge";
import type { DialogName } from "../commands";
import type { Playtest } from "../phaser/playtest";
import type { Workspace } from "../project/workspace";
import type { ProjectStore } from "../store/project";

export interface EditorContextValue {
  store: ProjectStore;
  bridge: EditorBridge;
  playtest: Playtest;
  workspace: Workspace;
  dialog: DialogName;
  openDialog: (name: DialogName) => void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside <EditorContext.Provider>");
  return ctx;
}

/** Re-renders the caller whenever the store changes. */
export function useStoreVersion(store: ProjectStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

/** Re-renders the caller whenever the workspace (disk state) changes. */
export function useWorkspace(workspace: Workspace): number {
  return useSyncExternalStore(workspace.subscribe, () => workspace.revision);
}
