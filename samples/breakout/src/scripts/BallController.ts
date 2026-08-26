import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * The ball, and with it the shape of a life: docked on the paddle, launched by
 * a click, lost when it falls past the floor.
 *
 * It owns the ball/paddle collider itself rather than leaving it to the
 * project's collision matrix. The matrix can say that two groups collide, but
 * a "collide" pair is emitted without a callback — only "overlap" pairs get
 * one — and the angle the ball leaves the paddle at is the whole feel of
 * breakout. One collider registered here is both the bounce and the hook.
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

  @property({
    label: "solid floor",
    hint: "off lets the ball fall out of play, which is what costs a life",
  })
  solidFloor = false;

  private paddle: Phaser.Physics.Arcade.Sprite | null = null;
  private docked = true;
  private over = false;

  create(): void {
    // Arcade's world bounds are one rectangle with a flag per side, and the
    // floor has to be open for a ball to ever be lost. Mosaic authors the
    // rectangle — width, height and whether a body is kept inside it — but not
    // the four flags, so the fourth is set here.
    this.scene.physics.world.setBoundsCollision(true, true, true, this.solidFloor);

    this.paddle = this.scene.children.getByName(this.paddleName) as Phaser.Physics.Arcade.Sprite | null;
    if (this.paddle) {
      this.scene.physics.add.collider(this.object, this.paddle, () => this.offPaddle());
    }

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
