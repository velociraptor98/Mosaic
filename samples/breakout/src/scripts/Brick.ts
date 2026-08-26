import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Attached to the Brick prefab, so all sixty bricks share one behaviour and
 * the six colours are variants of it rather than six kinds of object.
 *
 * `points` and `hits` are exposed on the prefab, which is what lets a row be
 * worth more, or take two hits, without being a different thing.
 */
export class Brick extends ScriptComponent {
  @property({ min: 0, max: 1000, hint: "added to the score when the brick is broken" })
  points = 10;

  @property({ min: 1, max: 5, label: "hits to break" })
  hits = 1;

  @property({ label: "ball object", hint: "name of the object that breaks this brick" })
  ballName = "Ball";

  private left = 1;

  create(): void {
    this.left = this.hits;
    const ball = this.scene.children.getByName(this.ballName) as Phaser.Physics.Arcade.Sprite | null;
    // Bounce and hook in one call, for the reason BallController gives: the
    // collision matrix hands a callback to "overlap" pairs and not to
    // "collide" ones, and a brick needs both.
    if (ball) this.scene.physics.add.collider(this.object, ball, () => this.hit());

    // The director counts the wall rather than being told how big it is, so
    // adding a row in the editor needs no matching edit anywhere in code.
    this.scene.events.emit("brick-added");
    this.scene.events.on("wall-restored", this.restore, this);
  }

  destroy(): void {
    this.scene.events.off("wall-restored", this.restore, this);
  }

  private hit(): void {
    if (!this.object.active) return;
    this.left -= 1;
    if (this.left > 0) {
      // Cracked, not gone: the same brick, visibly worn.
      this.object.setAlpha(0.55);
      return;
    }
    (this.object as Phaser.Physics.Arcade.Sprite).disableBody(true, true);
    this.scene.events.emit("brick-broken", this.points);
  }

  private restore(): void {
    this.left = this.hits;
    this.object.setAlpha(1);
    (this.object as Phaser.Physics.Arcade.Sprite).enableBody(false, 0, 0, true, true);
    // Announced again, exactly as it was on the first tick. A brick that came
    // back without saying so left the director counting a wall of nothing:
    // sixty bricks on screen and BRICKS 0 on the HUD.
    this.scene.events.emit("brick-added");
  }
}
