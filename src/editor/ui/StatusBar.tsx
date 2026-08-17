import { useRef } from "react";
import type { ProjectData } from "../../shared/types";
import { downloadText } from "../export/write";
import { useEditor, useStoreVersion } from "./context";

export function StatusBar() {
  const { store } = useEditor();
  useStoreVersion(store);
  const fileRef = useRef<HTMLInputElement>(null);

  const stack = store.stack();
  const errors = store.validate().filter((i) => i.level === "error").length;
  const scene = store.scene;

  return (
    <footer className="statusbar">
      <span className="status-text">{store.ui.status}</span>
      {store.storageWarning && <span className="warn">{store.storageWarning}</span>}
      <div className="toolbar-spacer" />
      {errors > 0 && <span className="warn">{errors} validation error(s)</span>}
      <span>
        {scene?.objects.length ?? 0} objects · {scene?.layers.length ?? 0} layers
      </span>
      <span title="Undo depth on this scene's own stack">
        undo {stack.depth}
        {store.isDirty(store.activeSceneKey) ? " · modified" : ""}
      </span>
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
