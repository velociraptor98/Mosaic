import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * The paddle follows the pointer, clamped so it never leaves the court.
 *
 * The original example clamped to the literals 52 and 748 — half a paddle in
 * from each wall of an 800px canvas. Both numbers are derived here instead:
 * the margin is half the paddle's own width by default, and the far edge comes
 * from the world bounds the scene authored. Resizing the canvas in Mosaic then
 * moves the clamp with it, rather than leaving the paddle able to slide a
 * quarter of the way off a wider screen.
 */
export class PaddleController extends ScriptComponent {
  @property({
    min: 0,
    max: 400,
    label: "edge margin (px)",
    hint: "how close to a wall the paddle's centre may get; 0 uses half its width",
  })
  edgeMargin = 0;

  @property({
    min: 0,
    max: 0.95,
    step: 0.05,
    label: "follow lag",
    hint: "0 snaps to the pointer; higher trails behind it",
  })
  followLag = 0;

  private targetX = 0;

  create(): void {
    this.targetX = this.object.x;
    this.scene.input.on("pointermove", this.onPointer, this);
  }

  update(): void {
    const margin = this.edgeMargin || this.object.displayWidth / 2;
    const width = this.scene.physics.world.bounds.width;
    const wanted = Phaser.Math.Clamp(this.targetX, margin, width - margin);
    // Linear with t = 1 is a straight assignment, so the no-lag case costs
    // nothing and there is no second code path to keep correct.
    this.object.setX(Phaser.Math.Linear(this.object.x, wanted, 1 - this.followLag));
  }

  destroy(): void {
    this.scene.input.off("pointermove", this.onPointer, this);
  }

  private onPointer(pointer: Phaser.Input.Pointer): void {
    this.targetX = pointer.x;
  }
}
