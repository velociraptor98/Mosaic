import { property } from "../scripts/ScriptComponent";
import { BulletBase } from "./Bullet.layout";

/**
 * Bullet — this file is yours.
 *
 * Never placed in the editor: it is a prefab so that its art, its body and its
 * numbers are authored there, and it is made from code with Bullet.spawn().
 */
export class Bullet extends BulletBase {
  @property({ min: 50, max: 1500 })
  speed = 520;

  @property({ label: "lifetime (ms)", min: 50, max: 5000 })
  lifetime = 900;

  private diesAt = Infinity;

  /**
   * Sends it on its way. Call after it has joined its group: joining resets
   * the body, velocity included, and the layout's group puts back only the
   * authored shape and settings.
   */
  fire(angle: number): this {
    this.setRotation(angle);
    this.scene.physics.velocityFromRotation(angle, this.speed, this.body.velocity);
    this.diesAt = this.scene.time.now + this.lifetime;
    return this;
  }

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (time >= this.diesAt) this.destroy();
  }
}
