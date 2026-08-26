import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * The round itself: the score, the lives, the HUD and the ending.
 *
 * It is attached to a marker object that hides itself at runtime — the same
 * arrangement Coin Rush uses, and for the same reason: one object in the scene
 * means "the round is here", and it owns the rules of the round.
 *
 * Nothing calls into this class. Bricks and the ball emit scene events and
 * this listens, so a brick does not need to know that a score exists.
 */
export class BreakoutDirector extends ScriptComponent {
  @property({ min: 1, max: 9, label: "lives" })
  lives = 3;

  @property({ min: 0, max: 5000, label: "bonus for clearing the wall" })
  clearBonus = 500;

  @property({
    label: "rebuild the wall",
    hint: "on puts every brick back when the last one goes, the way the original does",
  })
  rebuildWall = true;

  private score = 0;
  private livesLeft = 3;
  private wallSize = 0;
  private standing = 0;
  private over = false;
  private hud: Phaser.GameObjects.Text | null = null;
  private banner: Phaser.GameObjects.Text | null = null;

  create(): void {
    this.livesLeft = this.lives;
    // The marker is an editing aid, not scenery: visible while you place it,
    // gone once the game runs.
    this.object.setVisible(false);

    // The HUD is AUTHORED, not built here. Where the score sits, how big it is
    // and whether it is pinned to the camera are content decisions and they
    // live in the scene file with everything else. This only writes into it.
    this.hud = this.scene.children.getByName("HUD") as Phaser.GameObjects.Text | null;
    this.banner = this.scene.children.getByName("Banner") as Phaser.GameObjects.Text | null;

    this.scene.events.on("brick-added", this.onBrickAdded, this);
    this.scene.events.on("brick-broken", this.onBrickBroken, this);
    this.scene.events.on("ball-lost", this.onBallLost, this);
    this.draw();
  }

  destroy(): void {
    this.scene.events.off("brick-added", this.onBrickAdded, this);
    this.scene.events.off("brick-broken", this.onBrickBroken, this);
    this.scene.events.off("ball-lost", this.onBallLost, this);
  }

  private onBrickAdded(): void {
    this.wallSize += 1;
    this.standing += 1;
    this.draw();
  }

  private onBrickBroken(points: number): void {
    if (this.over) return;
    this.score += points;
    this.standing -= 1;
    // Guarded on wallSize because every brick registers itself on the first
    // tick: before any of them has, a wall of nothing is not a cleared one.
    if (this.wallSize > 0 && this.standing <= 0) this.clear();
    else this.draw();
  }

  private onBallLost(): void {
    if (this.over) return;
    this.livesLeft -= 1;
    this.scene.cameras.main.shake(120, 0.008);
    if (this.livesLeft <= 0) this.finish("GAME OVER");
    else this.draw();
  }

  private clear(): void {
    this.score += this.clearBonus;
    if (!this.rebuildWall) {
      this.finish("WALL CLEARED");
      return;
    }
    this.standing = 0;
    this.wallSize = 0;
    this.scene.events.emit("wall-restored");
    this.scene.events.emit("ball-reset");
    this.draw();
  }

  private finish(message: string): void {
    this.over = true;
    this.scene.events.emit("round-over");
    this.banner?.setText(message + "\n" + this.score);
    this.draw();
  }

  private draw(): void {
    this.hud?.setText(
      `SCORE ${this.score}    LIVES ${Math.max(0, this.livesLeft)}    BRICKS ${Math.max(0, this.standing)}`,
    );
  }
}
