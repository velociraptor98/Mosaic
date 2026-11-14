import { useEffect, useState, useSyncExternalStore } from "react";
import { startPlaytest, stopAndPrompt } from "../commands";
import { MosaicLockup } from "./Logo";
import { useEditor, useStoreVersion } from "./context";
import { platform } from "../platform";

/**
 * Menu bar + transport. On a project folder RUN is the project's own game,
 * served by its own dev server and shown beside the canvas. Without one it is
 * the in-editor preview, where PAUSE freezes the loop and STEP advances
 * exactly one update.
 */
export function MenuBar() {
  const { store, bridge, playtest, workspace, openDialog } = useEditor();
  useStoreVersion(store);
  const [transport, setTransport] = useState({ playing: false, paused: false, frame: 0 });

  useEffect(() => {
    const onPlay = (state: { playing: boolean; paused: boolean; frame: number }) =>
      setTransport(state);
    bridge.on("playtest", onPlay);
    return () => {
      bridge.off("playtest", onPlay);
    };
  }, [bridge]);

  useSyncExternalStore(playtest.subscribeGame, playtest.getGameRevision);
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
          // The project's own game: there is no frame to step, because the
          // loop belongs to the game and not to the editor.
          <>
            <span className="running-badge">
              {game.status === "starting" ? "STARTING" : game.status === "failed" ? "FAILED" : "RUNNING · GAME"}
            </span>
            {game.status === "running" && (
              <button className="ghost" onClick={() => playtest.reloadGame()} title="Reload the game">
                ↻
              </button>
            )}
            <button
              className="stop"
              onClick={() => stopAndPrompt({ store, playtest, workspace, openDialog })}
              title="Close the game (Ctrl/⌘↵)"
            >
              ■ STOP
            </button>
          </>
        ) : !transport.playing ? (
          <button
            className="run"
            onClick={() => startPlaytest({ store, playtest, workspace, openDialog })}
            title={
              playtest.runsGame
                ? "Run the game from the project's dev server (Ctrl/⌘↵)"
                : "Preview the scene (Ctrl/⌘↵)"
            }
          >
            ▶ RUN
          </button>
        ) : (
          <>
            <span className="running-badge">
              {transport.paused ? "PAUSED" : "PREVIEW"} · f{transport.frame}
            </span>
            <button
              className="ghost"
              onClick={() => (transport.paused ? playtest.resume() : playtest.pause())}
              title="Pause / resume (F5)"
            >
              {transport.paused ? "▶" : "⏸"}
            </button>
            <button className="ghost" onClick={() => playtest.step()} title="Step one frame (F6)">
              ⏭
            </button>
            <button
              className="stop"
              onClick={() => stopAndPrompt({ store, playtest, workspace, openDialog })}
              title="Stop and restore the snapshot"
            >
              ■ STOP
            </button>
          </>
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
