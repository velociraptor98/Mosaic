import Phaser from "phaser";
import { ZombieBase } from "./Zombie.layout";

/**
 * Zombie — this file is yours.
 *
 * Shambles toward the player and bites. Robot is a variant of this prefab: the
 * same class with other art, another walk and bigger numbers, set on the
 * variant in the editor.
 */
export class Zombie extends ZombieBase {
  /** Pixels per second. @editable { min: 0, max: 300 } */
  speed = 75;

  /** Hits it takes. @editable { min: 1, max: 50 } */
  health = 3;

  /** Health taken by a bite. @editable { min: 0, max: 100 } */
  damage = 10;

  /** Score for putting it down. @editable { min: 0, max: 1000 } */
  points = 10;

  alive = true;
  private target?: Phaser.GameObjects.Components.Transform;
  private lastBite = 0;

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive) return;
    // The layout names everything it places, so the player is found by name.
    this.target ??= this.scene.children.getByName("Player") as never;
    if (!this.target) return;
    const angle = Phaser.Math.Angle.Between(this.x, this.y, this.target.x, this.target.y);
    this.setRotation(angle);
    this.scene.physics.velocityFromRotation(angle, this.speed, this.body.velocity);
  }

  /** Takes a hit. True when it was the last one. */
  hurt(amount: number): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.setTint(0xff7777);
    this.scene.time.delayedCall(90, () => this.clearTint());
    if (this.health > 0) return false;
    this.alive = false;
    this.body.enable = false;
    this.stop();
    this.scene.sound.play("audio_splat", { volume: 0.6 });
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      scale: this.scale * 0.7,
      duration: 350,
      onComplete: () => this.destroy(),
    });
    return true;
  }

  /** At most one bite every 700ms. */
  canBite(time: number): boolean {
    if (time - this.lastBite < 700) return false;
    this.lastBite = time;
    return true;
  }
}
