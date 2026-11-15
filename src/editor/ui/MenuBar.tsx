import { useSyncExternalStore } from "react";
import { startPlaytest } from "../commands";
import { MosaicLockup } from "./Logo";
import { useEditor, useStoreVersion } from "./context";
import { platform } from "../platform";

/**
 * Menu bar + transport. RUN is the project's own game, served by its own dev
 * server and shown beside the canvas.
 */
export function MenuBar() {
  const { store, playtest, workspace, openDialog } = useEditor();
  useStoreVersion(store);
  useSyncExternalStore(playtest.subscribe, playtest.getRevision);
  const game = playtest.run;
  const scene = store.scene;
  const doc = store.prefabDoc;
  const stack = store.stack();

  return (
    <header className="menubar">
      {/* Full lockup in the title bar, then the project / scene readout the
          identity sheet places beside it. */}
      <MosaicLockup size={24} />

      <span className="menubar-rule" />

      <div className="menubar-scene">
        <span className="menubar-project" title={`Project: ${store.project.name}`}>
          {store.project.name}
        </span>
        <span className="menubar-slash">/</span>
        <select
          value={store.activeSceneKey}
          onChange={(e) => store.activateScene(e.target.value)}
          title="Switching scenes keeps each scene's selection, camera and undo stack"
        >
          {store.project.scenes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
              {store.isDirty(s.key) ? " ●" : ""}
            </option>
          ))}
        </select>
        {/* The prefab document sits ABOVE the scene it was opened from: the
            scene stays open, and this says which document you are in. */}
        {doc && (
          <>
            <span className="menubar-slash">/</span>
            <span className="doc-tab" title={`Editing the definition ${doc.name}.prefab`}>
              ◆ {doc.name}.prefab
              {store.isDirty(doc.scene.key) ? " ●" : ""}
            </span>
          </>
        )}
        <button className="ghost" onClick={() => openDialog("newscene")} title="New scene (Ctrl/⌘N)">
          + Scene
        </button>
      </div>

      <div className="menubar-group">
        <button className="ghost" disabled={!stack.canUndo} onClick={() => store.undo()} title={stack.undoLabel ?? "Undo"}>
          ↶ Undo
        </button>
        <button className="ghost" disabled={!stack.canRedo} onClick={() => store.redo()} title={stack.redoLabel ?? "Redo"}>
          ↷ Redo
        </button>
      </div>

      <button className="palette-field" onClick={() => openDialog("palette")}>
        <span>Search commands, scenes, assets…</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="transport">
        {game ? (
          <>
            <span className="running-badge">
              {game.status === "starting" ? "STARTING" : game.status === "failed" ? "FAILED" : "RUNNING"}
            </span>
            {game.status === "running" && (
              <button className="ghost" onClick={() => playtest.reload()} title="Reload the game">
                ↻
              </button>
            )}
            <button className="stop" onClick={() => playtest.stop()} title="Close the game (Ctrl/⌘↵)">
              ■ STOP
            </button>
          </>
        ) : (
          <button
            className="run"
            disabled={!playtest.canRun}
            onClick={() => startPlaytest({ store, playtest, workspace, openDialog })}
            title={
              playtest.canRun
                ? "Run the game from the project's dev server (Ctrl/⌘↵)"
                : "RUN runs your project's own dev server, so it needs a project folder in the desktop app"
            }
          >
            ▶ RUN
          </button>
        )}
      </div>

      <button className="ghost" onClick={() => openDialog("export")} title="What Mosaic writes for this scene (⌘E)">
        Code…
      </button>

      {/* The source, then the thing you send someone. */}
      {platform.canPackage && (
        <button className="primary" onClick={() => openDialog("package")} title="Build a folder you can ship (⌘⇧E)">
          Export game…
        </button>
      )}

      {scene && store.isDirty(scene.key) && <span className="tag-outline">unsaved</span>}
    </header>
  );
}
