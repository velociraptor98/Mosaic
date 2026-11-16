import Phaser from "phaser";
import { property } from "../scripts/ScriptComponent";
import { SpawnerBase } from "./Spawner.layout";

/** Emitted on the scene when a spawner wants an enemy: (x, y, kind). */
export const SPAWN = "spawn-enemy";

export type SpawnKind = "Enemy" | "Enemy_Fast";

/**
 * Spawner — this file is yours.
 *
 * A marker you place in the editor. It draws there so you can see and move it,
 * hides itself in the game, and asks the scene for an enemy on a timer. Each
 * one placed has its own interval and kind, set in the inspector — which is
 * the whole difficulty curve of the arena, with no code involved.
 */
export class Spawner extends SpawnerBase {
  @property({ label: "seconds between spawns", min: 0.5, max: 60, step: 0.5 })
  interval = 4;

  @property({ label: "first spawn after (s)", min: 0, max: 60, step: 0.5 })
  delay = 2;

  @property({ options: ["Enemy", "Enemy_Fast"] })
  kind: SpawnKind = "Enemy";

  private next = -1;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    this.setVisible(false);
  }

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    // The values arrive after the constructor, so the clock starts here.
    if (this.next < 0) this.next = time + this.delay * 1000;
    if (time < this.next) return;
    this.next = time + this.interval * 1000;
    this.scene.events.emit(SPAWN, this.x, this.y, this.kind);
  }
}
