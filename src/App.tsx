import { useCallback, useEffect, useMemo, useState } from "react";
import { EditorBridge } from "./editor/bridge";
import { buildCommands, startPlaytest, stopAndPrompt, type DialogName } from "./editor/commands";
import { PhaserHost } from "./editor/phaser/PhaserHost";
import { Playtest } from "./editor/phaser/playtest";
import { platform } from "./editor/platform";
import { DEFAULT_OPTIONS, planScaffold } from "./editor/project/scaffold";
import { Workspace } from "./editor/project/workspace";
import { ProjectStore } from "./editor/store/project";
import { isTrusted, revokeRoot, trustRoot } from "./editor/scripts/runtime";
import { BottomDock } from "./editor/ui/BottomDock";
import { EditorContext, useStoreVersion, useWorkspace } from "./editor/ui/context";
import { FirstRunChecklist } from "./editor/ui/FirstRunChecklist";
import { Launcher } from "./editor/ui/Launcher";
import { NewProjectFlow, type FirstRunInfo } from "./editor/ui/newproject/NewProjectFlow";
import { Inspector } from "./editor/ui/Inspector";
import { LeftDock } from "./editor/ui/LeftDock";
import { MenuBar } from "./editor/ui/MenuBar";
import { PrefabBar, ReviewBar } from "./editor/ui/PrefabBar";
import { SourceDrawer } from "./editor/ui/SourceDrawer";
import { StatusBar } from "./editor/ui/StatusBar";
import { Toolbar } from "./editor/ui/Toolbar";
import { AtlasDialog } from "./editor/ui/dialogs/AtlasDialog";
import { AttachScriptDialog } from "./editor/ui/dialogs/AttachScriptDialog";
import { ScriptTrustDialog } from "./editor/ui/dialogs/ScriptTrustDialog";
import { CollisionDialog } from "./editor/ui/dialogs/CollisionDialog";
import { CommandPalette } from "./editor/ui/dialogs/CommandPalette";
import { ExportDialog } from "./editor/ui/dialogs/ExportDialog";
import { ImportDialog } from "./editor/ui/dialogs/ImportDialog";
import { NewSceneDialog } from "./editor/ui/dialogs/NewSceneDialog";
import { PrefabDialog } from "./editor/ui/dialogs/PrefabDialog";
import { PromoteDialog } from "./editor/ui/dialogs/PromoteDialog";
import { PropagateDialog } from "./editor/ui/dialogs/PropagateDialog";

const store = new ProjectStore();
const bridge = new EditorBridge();
// The workspace comes first: the play-test compiles the project's scripts
// through it before it boots a scene.
const workspace = new Workspace(store);
const playtest = new Playtest(store, bridge, workspace);

// A debug handle for the desktop end-to-end test and for poking at state in
// devtools. Intentionally read-write: this is an editor, not a sandbox.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).mosaicDebug = {
    store,
    workspace,
    playtest,
    bridge,
    platform,
    scriptTrust: { isTrusted, trustRoot, revokeRoot },
    planScaffold,
    DEFAULT_OPTIONS,
  };
}

export default function App() {
  const [dialog, setDialog] = useState<DialogName>(null);
  const [creating, setCreating] = useState(false);
  const [firstRun, setFirstRun] = useState<FirstRunInfo | null>(null);
  const openDialog = useCallback((name: DialogName) => setDialog(name), []);

  const workspaceRevision = useWorkspace(workspace);
  // The propagation panel is opened by the store, not by a menu, so the shell
  // has to be listening to it.
  const storeVersion = useStoreVersion(store);
  void storeVersion;

  const ctx = useMemo(
    () => ({ store, bridge, playtest, workspace, dialog, openDialog }),
    [dialog, openDialog],
  );

  // Clicking a running game object binds the inspector to it.
  useEffect(() => {
    const onRuntimeSelect = (id: string | null) => id && store.setSelection([id]);
    bridge.on("runtimeSelection", onRuntimeSelect);
    return () => {
      bridge.off("runtimeSelection", onRuntimeSelect);
    };
  }, []);

  useKeyboardShortcuts(ctx);

  // Mosaic works on a folder: on desktop there is no editor to show until one
  // is open. The browser build has no folders, so it goes straight in.
  const needsProject = platform.canOpenProjects && !workspace.isOpen;
  void workspaceRevision;

  if (creating) {
    return (
      <EditorContext.Provider value={ctx}>
        <DragStrip />
        <NewProjectFlow
          workspace={workspace}
          onCancel={() => setCreating(false)}
          onCreated={(info) => {
            setCreating(false);
            setFirstRun(info);
          }}
        />
      </EditorContext.Provider>
    );
  }

  if (needsProject) {
    return (
      <EditorContext.Provider value={ctx}>
        <DragStrip />
        <Launcher workspace={workspace} onNewProject={() => setCreating(true)} />
      </EditorContext.Provider>
    );
  }

  return (
    <EditorContext.Provider value={ctx}>
      <div className="app">
        <MenuBar />
        <div className="app-body">
          <LeftDock />
          <main className="stage">
            {/* One wrapper, always present: the stage's rows are fixed, and a
                bar that comes and goes must not shift the canvas into a
                different one. */}
            <div className="stage-bars">
              {/* Prefab edit mode announces itself above the tools: you are
                  editing the definition, and every instance is downstream. */}
              <PrefabBar />
              <ReviewBar />
            </div>
            <Toolbar />
            {/* Registration marks: the reference brackets its blueprint
                frames this way, and the canvas is the one real drawing here. */}
            <div className="canvas-frame blueprint">
              <i className="corner tl" />
              <i className="corner tr" />
              <i className="corner bl" />
              <i className="corner br" />
              <PhaserHost store={store} bridge={bridge} playtest={playtest} />
              {/* Reading a class happens over the scene, not instead of it. */}
              <SourceDrawer />
            </div>
            <BottomDock />
          </main>
          <Inspector />
          {firstRun && workspace.location?.root === firstRun.root && (
            <FirstRunChecklist root={firstRun.root} installing={firstRun.installing} />
          )}
        </div>
        <StatusBar />

        {dialog === "palette" && <CommandPalette onClose={() => setDialog(null)} />}
        {dialog === "newscene" && <NewSceneDialog onClose={() => setDialog(null)} />}
        {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
        {dialog === "atlas" && <AtlasDialog onClose={() => setDialog(null)} />}
        {dialog === "prefab" && <PrefabDialog onClose={() => setDialog(null)} />}
        {dialog === "collision" && <CollisionDialog onClose={() => setDialog(null)} />}
        {dialog === "attachscript" && <AttachScriptDialog onClose={() => setDialog(null)} />}
        {dialog === "scripttrust" && <ScriptTrustDialog onClose={() => setDialog(null)} />}
        {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
        {dialog === "promote" && <PromoteDialog onClose={() => setDialog(null)} />}
        {store.ui.prefabPlan && <PropagateDialog onClose={() => setDialog(null)} />}
      </div>
    </EditorContext.Provider>
  );
}

/**
 * The launcher and the wizard draw no title bar, so without this there is
 * nothing to grab the window by on those screens.
 */
function DragStrip() {
  if (!platform.canOpenProjects) return null;
  return <div className="launcher-dragstrip" />;
}

/**
 * Every registered command has a binding, and the palette shows it. Keys are
 * handled here rather than in Phaser so they work wherever focus happens to be
 * — except inside a text field, where they are the user's keystrokes.
 */
function useKeyboardShortcuts(ctx: {
  store: ProjectStore;
  playtest: Playtest;
  workspace: Workspace;
  openDialog: (name: DialogName) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ctx.openDialog("palette");
        return;
      }
      if (typing) return;

      const commands = buildCommands(ctx);
      const run = (id: string) => {
        e.preventDefault();
        commands.find((c) => c.id === id)?.run();
      };

      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            return run(e.shiftKey ? "edit.redo" : "edit.undo");
          case "y":
            return run("edit.redo");
          case "d":
            return run("edit.duplicate");
          case "p":
            if (e.shiftKey) return run("prefab.create");
            return;
          case "g":
            return run("edit.group");
          case "n":
            return run(e.shiftKey ? "project.new" : "scene.new");
          case "o":
            return run("project.open");
          case "s":
            return run("project.save");
          case "w":
            return run("project.close");
          case "e":
            return run("scene.export");
          case "i":
            return run("asset.import");
          case "enter":
            e.preventDefault();
            return ctx.playtest.playing ? stopAndPrompt(ctx) : startPlaytest(ctx);
          default:
            return;
        }
      }

      switch (e.key) {
        case "v":
          return run("tool.select");
        case "b":
          return run("tool.place");
        case "p":
          return run("tool.brush");
        case "r":
          return run("tool.rect");
        case "e":
          return run("tool.erase");
        case "s":
          return run("view.snap");
        case "g":
          return run("view.grid");
        case "t":
          return run("object.text");
        case "F2":
          return run("view.bodies");
        case "F5":
          return run("play.pause");
        case "F6":
          return run("play.step");
        case "Delete":
        case "Backspace":
          return run("edit.delete");
        case "Escape":
          ctx.store.setSelection([]);
          return;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx]);
}
