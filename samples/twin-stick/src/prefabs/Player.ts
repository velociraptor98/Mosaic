import Phaser from "phaser";
import { property } from "../scripts/ScriptComponent";
import { PlayerBase } from "./Player.layout";

/** Emitted on the player when a shot leaves: (x, y, angle in radians). */
export const FIRE = "fire";

const STICK_DEADZONE = 0.25;

/**
 * Player — this file is yours.
 *
 * Twin-stick: one hand moves, the other aims. On a keyboard that is WASD and
 * the mouse; on a gamepad it is the two sticks, and pushing the right stick
 * fires. The art and the body come from PlayerBase, which Mosaic regenerates.
 *
 * The fields marked @property are the ones worth tuning without a rebuild:
 * they show in Mosaic's inspector, and the value set there wins.
 */
export class Player extends PlayerBase {
  @property({ min: 0, max: 600 })
  speed = 240;

  @property({ label: "shots per second", min: 1, max: 20 })
  fireRate = 6;

  @property({ min: 1, max: 10 })
  hp = 3;

  private keys: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private nextShot = 0;
  private move = new Phaser.Math.Vector2();

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    this.keys = scene.input.keyboard!.addKeys("W,A,S,D") as typeof this.keys;
  }

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const pad = this.scene.input.gamepad?.getPad(0);

    // --- left hand: move
    this.move.set(
      Number(this.keys.D.isDown) - Number(this.keys.A.isDown),
      Number(this.keys.S.isDown) - Number(this.keys.W.isDown),
    );
    if (pad && pad.leftStick.length() > STICK_DEADZONE) this.move.copy(pad.leftStick);
    if (this.move.lengthSq() > 1) this.move.normalize();
    this.setVelocity(this.move.x * this.speed, this.move.y * this.speed);

    // --- right hand: aim, and fire
    let angle: number;
    let firing: boolean;
    if (pad && pad.rightStick.length() > STICK_DEADZONE) {
      angle = pad.rightStick.angle();
      firing = true;
    } else {
      const pointer = this.scene.input.activePointer;
      // Asked of the camera each frame: the pointer's own world position goes
      // stale the moment the camera scrolls under a mouse that is not moving.
      const at = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
      angle = Phaser.Math.Angle.Between(this.x, this.y, at.x, at.y);
      firing = pointer.isDown;
    }
    // The capsule is drawn pointing up; rotation 0 points right.
    this.setRotation(angle + Math.PI / 2);

    if (firing && time >= this.nextShot) {
      this.nextShot = time + 1000 / this.fireRate;
      this.emit(FIRE, this.x + Math.cos(angle) * 22, this.y + Math.sin(angle) * 22, angle);
    }
  }

  /** Takes one hit. True when it was the last one. */
  hurt(): boolean {
    this.hp -= 1;
    this.setAlpha(0.4);
    this.scene.time.delayedCall(120, () => this.setAlpha(1));
    return this.hp <= 0;
  }
}
