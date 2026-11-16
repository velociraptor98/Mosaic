import { BulletBase } from "./Bullet.layout";

/**
 * Bullet — this file is yours.
 *
 * Never placed in the editor: the player makes these with `new Bullet()`.
 * Its art, body and group come from the prefab all the same.
 */
export class Bullet extends BulletBase {
  /** Pixels per second. @editable { min: 100, max: 2000 } */
  speed = 950;

  /** Hits it takes off whatever it strikes. @editable { min: 1, max: 10 } */
  damage = 1;

  /** Milliseconds before it is spent. @editable { min: 100, max: 3000 } */
  life = 650;

  private spentAt = 0;

  /** Sends it off along `angle` (radians). The art points up, so it is turned a quarter. */
  launch(angle: number): this {
    this.setRotation(angle + Math.PI / 2);
    this.scene.physics.velocityFromRotation(angle, this.speed, this.body.velocity);
    this.spentAt = this.scene.time.now + this.life;
    return this;
  }

  /** Stops it where it struck. */
  spark(): void {
    if (!this.active) return;
    this.scene.sound.play("audio_hit", { volume: 0.25 });
    this.destroy();
  }

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (time >= this.spentAt) this.destroy();
  }
}
