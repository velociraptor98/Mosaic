import { SpawnerBase } from "./Spawner.layout";

/**
 * Spawner — this file is yours.
 *
 * A hatch the dead climb out of. Each one placed in the level has its own
 * kind, rate and head start, set in the inspector; the scene decides how many
 * come in a wave.
 */
export class Spawner extends SpawnerBase {
  /** What climbs out. @editable { options: ["Zombie", "Robot"] } */
  kind: "Zombie" | "Robot" = "Zombie";

  /** Milliseconds between arrivals. @editable { min: 300, max: 20000, step: 100 } */
  every = 3000;

  /** Milliseconds into a wave before the first. @editable { min: 0, max: 20000, step: 100 } */
  delay = 0;

  private next = -1;

  /** True when it is time for this one to let something out. */
  ready(time: number): boolean {
    if (this.next < 0) this.next = time + this.delay;
    if (time < this.next) return false;
    this.next = time + this.every;
    return true;
  }

  /** Back to its own delay, for a new wave. */
  rewind(): void {
    this.next = -1;
  }

  pulse(): void {
    this.scene.tweens.add({ targets: this, scale: this.scale * 1.2, duration: 120, yoyo: true });
  }
}
