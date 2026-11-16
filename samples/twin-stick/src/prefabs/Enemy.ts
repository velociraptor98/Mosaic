import Phaser from "phaser";
import { property } from "../scripts/ScriptComponent";
import { EnemyBase } from "./Enemy.layout";

/**
 * Enemy — this file is yours.
 *
 * Walks at whatever it has been told to chase. Enemy_Fast is a variant of this
 * prefab, so it IS this class — same behaviour — with different numbers set on
 * its definition in the editor.
 */
export class Enemy extends EnemyBase {
  @property({ min: 0, max: 400 })
  speed = 90;

  @property({ min: 1, max: 20 })
  hp = 2;

  @property({ label: "points when destroyed", min: 0, max: 1000 })
  points = 10;

  /** Set by the scene: the layout does not know who is hunting whom. */
  target?: Phaser.GameObjects.Sprite;

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.target?.active) {
      this.setVelocity(0, 0);
      return;
    }
    const angle = this.scene.physics.moveToObject(this, this.target, this.speed);
    this.setRotation(angle + Math.PI / 2);
  }

  /** Takes one bullet. True when that destroyed it. */
  hit(): boolean {
    this.hp -= 1;
    if (this.hp <= 0) {
      this.destroy();
      return true;
    }
    this.setAlpha(0.5);
    this.scene.time.delayedCall(60, () => this.active && this.setAlpha(1));
    return false;
  }
}
