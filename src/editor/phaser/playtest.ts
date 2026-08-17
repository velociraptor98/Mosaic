import Phaser from "phaser";
import type { SceneData } from "../../shared/types";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";
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

  constructor(store: ProjectStore, bridge: EditorBridge) {
    this.store = store;
    this.bridge = bridge;
  }

  private get playScene(): PlayScene | null {
    return (this.game?.registry.get("playScene") as PlayScene | undefined) ?? null;
  }

  start(): void {
    const scene = this.store.scene;
    if (!this.game || !scene || this.playing) return;
    this.snapshot = structuredClone(scene);
    this.pending = [];
    this.playing = true;
    this.paused = false;

    this.game.scene.stop("EditorScene");
    this.game.scene.start("PlayScene", {
      project: structuredClone(this.store.project),
      scene: structuredClone(scene),
      bridge: this.bridge,
      debug: true,
    });
    this.bridge.send("playtest", { playing: true, paused: false, frame: 0 });
    this.store.setStatus(`Playtest ${scene.key} — editor state snapshotted, not mutated`);
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
