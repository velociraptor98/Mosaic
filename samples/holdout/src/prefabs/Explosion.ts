import Phaser from "phaser";
import { ExplosionBase } from "./Explosion.layout";

/**
 * Explosion — this file is yours.
 *
 * Its animation and its sound are set on the prefab in the editor ("play on
 * spawn" and "on spawn"), and ExplosionBase starts both in its constructor, so
 * `new Explosion(scene, x, y)` is the whole of making one. This only tidies up.
 */
export class Explosion extends ExplosionBase {
  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    this.setAngle(Phaser.Math.Between(0, 359));
    this.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => this.destroy());
  }
}
