import { useEffect, useState } from "react";
import { startPlaytest, stopAndPrompt } from "../commands";
import { MosaicLockup } from "./Logo";
import { useEditor, useStoreVersion } from "./context";

/**
 * Menu bar + transport. RUN boots the scene into the canvas you were editing;
 * PAUSE freezes the loop and STEP advances exactly one update.
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

  const scene = store.scene;
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
        {!transport.playing ? (
          <button
            className="run"
            onClick={() => startPlaytest({ store, playtest, workspace, openDialog })}
            title="Run (Ctrl/⌘↵)"
          >
            ▶ RUN
          </button>
        ) : (
          <>
            <span className="running-badge">
              {transport.paused ? "PAUSED" : "RUNNING"} · f{transport.frame}
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

      <button className="primary" onClick={() => openDialog("export")}>
        Export scene…
      </button>

      {scene && store.isDirty(scene.key) && <span className="tag-outline">unsaved</span>}
    </header>
  );
}
