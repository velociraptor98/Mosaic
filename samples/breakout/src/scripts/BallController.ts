import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * The ball, and with it the shape of a life: docked on the paddle, launched by
 * a click, lost when it falls past the floor.
 *
 * The bounce off the paddle is the collision matrix's — ball × paddle is
 * authored as "collide" once, in the project, rather than as a collider this
 * class registers for itself. What arrives here is `onContact`, with the thing
 * that was hit, and the angle the ball leaves at is the whole feel of breakout.
 */
export class BallController extends ScriptComponent {
  @property({ label: "paddle object", hint: "name of the object the ball rests on" })
  paddleName = "Paddle";

  @property({ min: -400, max: 400, label: "launch velocity X" })
  launchX = -75;

  @property({ min: -800, max: -60, label: "launch velocity Y" })
  launchY = -300;

  @property({ min: 0, max: 160, label: "rest height (px)", hint: "how far above the paddle the ball waits" })
  restHeight = 50;

  @property({
    min: 0,
    max: 40,
    label: "paddle english",
    hint: "sideways speed added per pixel between the ball and the paddle's centre",
  })
  english = 10;

  private paddle: Phaser.Physics.Arcade.Sprite | null = null;
  private docked = true;
  private over = false;

  create(): void {
    // The open floor is SCENE data — Inspector → Scene → World edges — and the
    // ball/paddle collider is the project's collision matrix. Neither is set
    // up here any more; this class only says what to do about them.
    this.paddle = this.scene.children.getByName(this.paddleName) as Phaser.Physics.Arcade.Sprite | null;

    this.scene.input.on("pointerup", this.launch, this);
    this.scene.events.on("ball-reset", this.dock, this);
    this.scene.events.on("round-over", this.stop, this);
    this.dock();
  }

  update(): void {
    if (this.docked) {
      if (this.paddle) this.object.setPosition(this.paddle.x, this.paddle.y - this.restHeight);
      return;
    }
    // Below the floor by its own height, so the ball is gone rather than
    // merely touching the line.
    const floor = this.scene.physics.world.bounds.height + this.object.displayHeight;
    if (this.object.y <= floor) return;

    // Docked BEFORE the announcement: whoever is counting lives may or may not
    // exist, and a ball that keeps falling would announce its loss every frame.
    this.dock();
    this.scene.events.emit("ball-lost");
  }

  /** ball × paddle, from the collision matrix. */
  onContact(other: Phaser.GameObjects.GameObject): void {
    if (other === this.paddle) this.offPaddle();
  }

  destroy(): void {
    this.scene.input.off("pointerup", this.launch, this);
    this.scene.events.off("ball-reset", this.dock, this);
    this.scene.events.off("round-over", this.stop, this);
  }

  private dock(): void {
    this.docked = true;
    const body = this.object.body as Phaser.Physics.Arcade.Body | null;
    body?.setVelocity(0, 0);
    if (this.paddle) this.object.setPosition(this.paddle.x, this.paddle.y - this.restHeight);
  }

  private stop(): void {
    this.over = true;
    this.dock();
  }

  private launch(): void {
    if (this.over || !this.docked) return;
    this.docked = false;
    (this.object.body as Phaser.Physics.Arcade.Body).setVelocity(this.launchX, this.launchY);
  }

  /**
   * Where the ball hits the paddle decides where it goes: further from the
   * centre is a wider angle. Hitting dead centre adds a small random nudge, or
   * the ball would bounce straight up and down forever.
   */
  private offPaddle(): void {
    if (!this.paddle) return;
    const body = this.object.body as Phaser.Physics.Arcade.Body;
    const offset = this.object.x - this.paddle.x;
    if (offset === 0) body.setVelocityX(2 + Math.random() * 8);
    else body.setVelocityX(this.english * offset);
  }
}
