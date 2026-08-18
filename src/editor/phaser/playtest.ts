import Phaser from "phaser";
import type { SceneData } from "../../shared/types";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";
import type { Workspace } from "../project/workspace";
import { isTrusted, type ScriptCtor } from "../scripts/runtime";
import type { PlayScene } from "./PlayScene";

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
  }

  private get playScene(): PlayScene | null {
    return (this.game?.registry.get("playScene") as PlayScene | undefined) ?? null;
  }

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
    void scene;
    const root = this.workspace.location?.root;
    if (!root || !this.sceneHasScripts()) return undefined;

    if (!isTrusted(root)) {
      this.store.setStatus(
        "Scripts are not running: this project has not been trusted to execute its code",
      );
      return undefined;
    }

    this.store.setStatus("Compiling scripts…");
    const ok = await this.workspace.scriptRuntime.build(root, this.workspace.scripts);
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

    const ok = await this.workspace.scriptRuntime.build(root, this.workspace.scripts);
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
