import { useRef } from "react";
import type { ProjectData } from "../../shared/types";
import { downloadText } from "../export/write";
import { platform } from "../platform";
import { useEditor, useStoreVersion, useWorkspace } from "./context";

export function StatusBar() {
  const { store, workspace } = useEditor();
  useStoreVersion(store);
  useWorkspace(workspace);
  const fileRef = useRef<HTMLInputElement>(null);
  const desktop = platform.canOpenProjects;

  const stack = store.stack();
  const errors = store.validate().filter((i) => i.level === "error").length;
  const scene = store.scene;
  const doc = store.prefabDoc;

  return (
    <footer className="statusbar">
      <span className="status-text">{store.ui.status}</span>
      {store.storageWarning && <span className="warn">{store.storageWarning}</span>}
      <div className="toolbar-spacer" />
      {errors > 0 && <span className="warn">{errors} validation error(s)</span>}
      <span>
        {doc
          ? `${scene?.objects.length ?? 0} parts · ${doc.exposed.length} exposed`
          : `${scene?.objects.length ?? 0} objects · ${scene?.layers.length ?? 0} layers`}
      </span>
      <span title={doc ? "Undo depth on this prefab's own stack" : "Undo depth on this scene's own stack"}>
        undo {stack.depth}
        {store.isDirty(store.docKey) ? " · modified" : ""}
      </span>
      {desktop && workspace.install?.running && (
        <span className="warn" title="Dependency install is running in the background">
          npm install · running
        </span>
      )}
      {desktop && workspace.install && !workspace.install.running && workspace.install.code !== 0 && (
        <span className="warn" title={workspace.install.log.slice(-400)}>
          npm install failed
        </span>
      )}
      {desktop ? (
        <>
          <span title={workspace.location?.root}>
            {workspace.saving
              ? "saving…"
              : workspace.lastSavedAt
                ? `saved ${new Date(workspace.lastSavedAt).toLocaleTimeString()}`
                : "not saved yet"}
          </span>
          <button className="mini" onClick={() => void workspace.saveNow()}>
            Save now
          </button>
          <button className="mini" onClick={() => void workspace.reload()}>
            Reload
          </button>
          <button className="mini" onClick={() => workspace.close()}>
            Close project
          </button>
        </>
      ) : (
        <>
          <button
            className="mini"
            onClick={() => downloadText(`${store.project.name.replace(/\s+/g, "-").toLowerCase()}.project.json`, JSON.stringify(store.project, null, 2))}
          >
            Save project
          </button>
          <button className="mini" onClick={() => fileRef.current?.click()}>
            Open project
          </button>
          <button className="mini danger" onClick={() => store.resetProject()}>
            Reset
          </button>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text()) as ProjectData;
            if (!parsed?.scenes?.length) throw new Error("Not a project file");
            store.loadProject(parsed);
          } catch (err) {
            store.setStatus(err instanceof Error ? err.message : "Could not open project");
          }
        }}
      />
    </footer>
  );
}
