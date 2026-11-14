import Phaser from "phaser";
import type { ProjectData, SceneData } from "../../shared/types";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";
import type { Workspace } from "../project/workspace";
import { isTrusted, type ScriptCtor } from "../scripts/runtime";
import type { PlayScene } from "./PlayScene";
import { platform } from "../platform";
import type { DevServerResult } from "../platform/types";
import { className } from "../export/generate";

/**
 * The project's own game, served by its own dev server.
 *
 * `starting` while the server boots, `running` once it has an address, and
 * `failed` with a code the UI can act on — "not installed" offers the install,
 * rather than only reporting that something went wrong.
 */
export interface GameRun {
  status: "starting" | "running" | "failed";
  root: string;
  url: string | null;
  error?: string;
  code?: DevServerResult["code"];
  log: string;
  /** Bumped to reload the page without restarting the server. */
  nonce: number;
}

export interface PendingPromotion {
  id: string;
  name: string;
  path: string;
  value: unknown;
  previous: unknown;
}

/**
 * Owns the run / pause / step / stop transport.
 *
 * Starting snapshots the scene rather than mutating it; stopping restores that
 * snapshot exactly and then offers to promote any runtime tweaks worth keeping
 * — promotion being one undoable transaction, the restore itself is not.
 */
export class Playtest {
  game: Phaser.Game | null = null;
  playing = false;
  paused = false;
  pending: PendingPromotion[] = [];

  private snapshot: SceneData | null = null;

  private store: ProjectStore;
  private bridge: EditorBridge;
  private workspace: Workspace;

  constructor(store: ProjectStore, bridge: EditorBridge, workspace: Workspace) {
    this.store = store;
    this.bridge = bridge;
    this.workspace = workspace;
    // An edit to a script's source while the scene is running restarts it on
    // the new code — the same thing a dev server does for game code.
    workspace.onScriptsChanged = (rels) => this.onScriptsChanged(rels);
    workspace.onClosing = (root) => this.shutdownGame(root);
  }

  private get playScene(): PlayScene | null {
    return (this.game?.registry.get("playScene") as PlayScene | undefined) ?? null;
  }

  // ------------------------------------------------------------- the game

  /**
   * RUN, when the project is a folder: its real game, from its real dev
   * server, beside the canvas.
   *
   * This is deliberately not a mode of the preview below. The preview builds a
   * scene from Mosaic's data with Mosaic's runtime; this runs the code the
   * developer wrote, through the bundler they chose, exactly as `npm run dev`
   * would — because it IS `npm run dev`. The editor stays live next to it:
   * every save rewrites the layout files, and the dev server reloads.
   */
  run: GameRun | null = null;
  gameRevision = 0;
  private gameListeners = new Set<() => void>();

  subscribeGame = (fn: () => void): (() => void) => {
    this.gameListeners.add(fn);
    return () => this.gameListeners.delete(fn);
  };

  getGameRevision = (): number => this.gameRevision;

  private setGame(next: GameRun | null): void {
    this.run = next;
    this.gameRevision += 1;
    for (const fn of this.gameListeners) fn();
  }

  /** True when RUN means the project's game rather than the in-editor preview. */
  get runsGame(): boolean {
    return platform.canRunGame && !!this.workspace.location && !this.workspace.deferredWrite;
  }

  /** The page RUN shows: the server's address, opened on the scene being edited. */
  gameUrl(): string | null {
    if (!this.run?.url) return null;
    try {
      const url = new URL(this.run.url);
      const key = this.store.activeSceneKey;
      if (key) url.searchParams.set("scene", className(key));
      return url.toString();
    } catch {
      return this.run.url;
    }
  }

  async startGame(): Promise<void> {
    const root = this.workspace.location?.root;
    if (!root) return;
    if (this.playing) this.stop();
    this.setGame({ status: "starting", root, url: null, log: "", nonce: 0 });
    this.store.setStatus("Starting the project's dev server…");

    // The game reads what is on disk, so what is on disk has to be current.
    await this.workspace.saveNow();
    const result = await platform.startDevServer(root);
    // STOP, or a different project, while the server was booting.
    if (this.run?.root !== root) return;

    if (!result.ok || !result.url) {
      this.setGame({
        status: "failed",
        root,
        url: null,
        error: result.error ?? "The dev server did not start.",
        code: result.code,
        log: result.log,
        nonce: 0,
      });
      this.store.setStatus(`Could not run the game — ${result.error ?? "the dev server did not start"}`);
      return;
    }
    this.setGame({ status: "running", root, url: result.url, log: result.log, nonce: 0 });
    this.store.setStatus(`Running the game from ${result.url} — edits reload it as you save`);
  }

  /** Reloads the page. The server, and whatever it has cached, stays up. */
  reloadGame(): void {
    if (this.run?.status !== "running") return;
    this.setGame({ ...this.run, nonce: this.run.nonce + 1 });
  }

  /**
   * Closes the game. The server is left running: starting one costs seconds,
   * and the next RUN should not pay for it again. It stops with the project.
   */
  stopGame(): void {
    if (!this.run) return;
    this.setGame(null);
    this.store.setStatus("Stopped — the dev server is still up for the next run");
  }

  /** Ends the server too. Called when the project closes. */
  shutdownGame(root: string): void {
    if (this.run?.root === root) this.setGame(null);
    void platform.stopDevServer(root);
  }

  // ---------------------------------------------------------- the preview

  /**
   * Builds the scene from its data, in the editor's own canvas.
   *
   * No project code is required for this, which is what it is for: seeing
   * bodies fall and colliders meet before there is a game to run, and the only
   * kind of run the browser build has.
   */
  start(): void {
    void this.startAsync();
  }

  /**
   * Compiling the project's scripts is the one asynchronous step between RUN
   * and a running scene, so the transport flips immediately and the scene
   * starts when the code is ready. A scene with no scripts never waits.
   */
  private async startAsync(): Promise<void> {
    const scene = this.store.scene;
    if (!this.game || !scene || this.playing) return;
    this.snapshot = structuredClone(scene);
    this.pending = [];
    this.playing = true;
    this.paused = false;
    this.bridge.send("playtest", { playing: true, paused: false, frame: 0 });

    const scripts = await this.compileScripts(scene);
    // STOP during the compile wins: nothing should start behind the user.
    if (!this.playing || !this.game) return;

    this.game.scene.stop("EditorScene");
    this.game.scene.start("PlayScene", {
      project: structuredClone(this.store.project),
      scene: structuredClone(scene),
      bridge: this.bridge,
      debug: true,
      scripts,
      prefabClasses: this.workspace.scriptRuntime.prefabClasses,
    });
    this.store.setStatus(
      scripts
        ? `Playtest ${scene.key} — running ${Object.keys(scripts).length} script class(es)`
        : `Playtest ${scene.key} — editor state snapshotted, not mutated`,
    );
  }

  /** True when this scene has behaviour the user has not yet agreed to run. */
  needsTrust(): boolean {
    const root = this.workspace.location?.root;
    if (!root || isTrusted(root)) return false;
    return this.sceneHasScripts();
  }

  private sceneHasScripts(): boolean {
    const scene = this.store.scene;
    return !!scene && scene.objects.some((o) => this.store.scriptsFor(o).length > 0);
  }

  private async compileScripts(
    scene: SceneData,
  ): Promise<Record<string, ScriptCtor> | undefined> {
    const root = this.workspace.location?.root;
    // Bound prefabs need the same compile scripts do — the project's class has
    // to exist before the scene can construct one. A scene with neither still
    // never waits.
    const bound = boundPrefabClasses(this.store.project).filter((b) =>
      scene.objects.some((o) => o.prefab === b.prefab),
    );
    if (!root || (!this.sceneHasScripts() && !bound.length)) return undefined;

    if (!isTrusted(root)) {
      this.store.setStatus(
        "Not running the project's own code: this folder has not been trusted to execute it",
      );
      return undefined;
    }

    this.store.setStatus("Compiling the project's code…");
    const ok = await this.workspace.scriptRuntime.build(root, this.workspace.scripts, bound);
    if (!ok) {
      this.store.setStatus(
        `Scripts did not compile — running without behaviour. ${this.workspace.scriptRuntime.error ?? ""}`,
      );
      return undefined;
    }
    return this.workspace.scriptRuntime.classes;
  }

  /**
   * A source edit under a running scene: recompile, and restart the scene on
   * the new code. Scene state is not carried across — a restart from the
   * snapshot is the honest reading of "the code changed", and it is what makes
   * the result reproducible.
   */
  private onScriptsChanged(rels: string[]): void {
    if (!this.playing) return;
    if (!this.workspace.scriptRuntime.affectedBy(rels)) return;
    void this.restartOnNewCode();
  }

  private async restartOnNewCode(): Promise<void> {
    const root = this.workspace.location?.root;
    if (!root || !this.snapshot || !this.game) return;
    this.store.setStatus("Scripts changed — recompiling…");

    const ok = await this.workspace.scriptRuntime.build(
      root,
      this.workspace.scripts,
      boundPrefabClasses(this.store.project),
    );
    if (!this.playing || !this.game) return;
    if (!ok) {
      // Keep the run alive on the last good build and say what is wrong; a
      // half-typed file should not stop the game you are testing.
      this.store.setStatus(
        `Scripts did not compile — still running the last good build. ${this.workspace.scriptRuntime.error ?? ""}`,
      );
      return;
    }

    this.game.scene.stop("PlayScene");
    this.game.scene.start("PlayScene", {
      project: structuredClone(this.store.project),
      scene: structuredClone(this.snapshot),
      bridge: this.bridge,
      debug: true,
      scripts: this.workspace.scriptRuntime.classes,
      prefabClasses: this.workspace.scriptRuntime.prefabClasses,
    });
    this.paused = false;
    this.bridge.send("playtest", { playing: true, paused: false, frame: 0 });
    this.store.setStatus("Scripts recompiled — scene restarted on the new code");
  }

  pause(): void {
    const play = this.playScene;
    if (!play || !this.playing) return;
    play.pauseRun();
    this.paused = true;
    this.bridge.send("playtest", { playing: true, paused: true, frame: play.frame });
  }

  resume(): void {
    const play = this.playScene;
    if (!play || !this.playing) return;
    play.resumeRun();
    this.paused = false;
    this.bridge.send("playtest", { playing: true, paused: false, frame: play.frame });
  }

  step(): void {
    const play = this.playScene;
    if (!play || !this.playing) return;
    play.stepFrame();
    this.paused = true;
    this.bridge.send("playtest", { playing: true, paused: true, frame: play.frame });
  }

  stop(): PendingPromotion[] {
    // STOP is one button to the user, so it ends whichever kind of run is
    // going. The game has no volatile edits to promote: its objects belong to
    // the project's own code, not to the editor's scene data.
    if (this.run) {
      this.stopGame();
      if (!this.playing) return [];
    }
    const play = this.playScene;
    const scene = this.store.scene;
    const edits = play?.volatileEdits() ?? [];

    this.pending = edits
      .map((edit) => {
        const obj = scene?.objects.find((o) => o.id === edit.id);
        if (!obj) return null;
        const previous = edit.path
          .split(".")
          .reduce<unknown>(
            (acc, part) =>
              acc && typeof acc === "object"
                ? (acc as Record<string, unknown>)[part]
                : undefined,
            obj,
          );
        if (JSON.stringify(previous) === JSON.stringify(edit.value)) return null;
        return { id: edit.id, name: obj.name, path: edit.path, value: edit.value, previous };
      })
      .filter((x): x is PendingPromotion => x !== null);

    if (this.game) {
      this.game.scene.stop("PlayScene");
      this.game.registry.remove("playScene");
      this.game.scene.start("EditorScene", { store: this.store, bridge: this.bridge });
    }

    // Restore the pre-play snapshot exactly. This is deliberately not an undo
    // entry: nothing the player did was an edit.
    if (this.snapshot) {
      const idx = this.store.project.scenes.findIndex((s) => s.key === this.snapshot!.key);
      if (idx >= 0) this.store.project.scenes[idx] = structuredClone(this.snapshot);
    }

    this.playing = false;
    this.paused = false;
    this.bridge.send("playtest", { playing: false, paused: false, frame: 0 });
    this.store.setStatus(
      this.pending.length
        ? `Stopped — ${this.pending.length} runtime edit(s) can be promoted`
        : "Stopped — scene restored from snapshot",
    );
    return this.pending;
  }

  /** Promotion is one undoable transaction. */
  promote(edits: PendingPromotion[]): void {
    if (!edits.length) return;
    this.store.transact("Promote runtime edits", () => {
      for (const edit of edits) this.store.setObjectProp(edit.id, edit.path, edit.value);
    });
    this.pending = [];
    this.store.setStatus(`Promoted ${edits.length} runtime edit(s) into the scene`);
  }

  discard(): void {
    this.pending = [];
    this.store.setStatus("Runtime edits discarded");
  }

  setRuntimeProp(id: string, path: string, value: unknown): void {
    this.playScene?.setRuntimeProp(id, path, value);
  }

  readRuntime(id: string): Record<string, unknown> | null {
    return this.playScene?.readRuntime(id) ?? null;
  }
}


/**
 * The project classes this scene's prefabs are bound to.
 *
 * Read from the project rather than the script index: the binding was decided
 * at import time and recorded on the prefab, and re-deriving it here could
 * disagree with what the exporter will emit.
 */
function boundPrefabClasses(
  project: ProjectData,
): { prefab: string; src: string; className: string; exportName: string }[] {
  const out: { prefab: string; src: string; className: string; exportName: string }[] = [];
  for (const prefab of project.prefabs) {
    if (!prefab.source) continue;
    out.push({
      prefab: prefab.name,
      src: prefab.source.module,
      className: prefab.name,
      exportName: prefab.source.export,
    });
  }
  return out;
}
