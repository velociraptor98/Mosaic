/**
 * The four script components of the Breakout sample, as source.
 *
 * They live here as strings for the same reason Coin Rush's do: the generator
 * writes them into the sample project and the verification notes quote them,
 * and both read the SAME constant, so what is described cannot drift from what
 * is on disk.
 *
 * Everything below is ordinary project code. It extends `ScriptComponent`,
 * which Mosaic copies into the project, and marks with `@property` the fields
 * the editor is allowed to set. The class says what exists; the scene file says
 * what it is set to.
 */

export interface GameScript {
  /** Class name, and therefore the file name under src/scripts/. */
  name: string;
  /** One line, for the summary table. */
  role: string;
  source: string;
}

const PADDLE_CONTROLLER = `import Phaser from "phaser";
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
`;

const BALL_CONTROLLER = `import Phaser from "phaser";
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
`;

const BRICK = `import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Attached to the Brick prefab, so all sixty bricks share one behaviour and
 * the six colours are variants of it rather than six kinds of object.
 *
 * \`points\` and \`hits\` are exposed on the prefab, which is what lets a row be
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
`;

const DIRECTOR = `import Phaser from "phaser";
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
    this.banner?.setText(message + "\\n" + this.score);
    this.draw();
  }

  private draw(): void {
    this.hud?.setText(
      \`SCORE \${this.score}    LIVES \${Math.max(0, this.livesLeft)}    BRICKS \${Math.max(0, this.standing)}\`,
    );
  }
}
`;

export const GAME_SCRIPTS: GameScript[] = [
  {
    name: "PaddleController",
    role: "follows the pointer, clamped to the court",
    source: PADDLE_CONTROLLER,
  },
  {
    name: "BallController",
    role: "docks, launches, bounces off the paddle, and announces a lost ball",
    source: BALL_CONTROLLER,
  },
  {
    name: "Brick",
    role: "takes hits, breaks, and puts itself back when the wall is rebuilt",
    source: BRICK,
  },
  {
    name: "BreakoutDirector",
    role: "score, lives, HUD, and the end of the round",
    source: DIRECTOR,
  },
];
