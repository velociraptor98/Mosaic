/**
 * The four script components of the Coin Rush sample, as source.
 *
 * They live here as strings for one reason: the generator writes them into the
 * sample project and the build guide prints them, and both read the SAME
 * constant — so the code in the PDF cannot drift from the code on disk.
 *
 * Everything below is ordinary project code. It extends `ScriptComponent`,
 * which Mosaic copies into the project, and marks with `@property` the fields
 * the editor is allowed to set. The class says what exists; the scene file
 * says what it is set to.
 */

export interface GameScript {
  /** Class name, and therefore the file name under src/scripts/. */
  name: string;
  /** One line, for the guide's contents table. */
  role: string;
  /** What is worth understanding about it, for the guide. */
  notes: string[];
  source: string;
}

const RUNNER_CONTROLLER = `import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Left / right and one jump. Everything a player can feel is a @property, so
 * the feel of the game is tuned in Mosaic rather than in this file.
 */
export class RunnerController extends ScriptComponent {
  @property({ min: 40, max: 600, hint: "horizontal speed in px/sec" })
  moveSpeed = 210;

  @property({ min: -900, max: -120, label: "jump velocity" })
  jumpVelocity = -430;

  @property({
    min: 0,
    max: 400,
    label: "coyote time (ms)",
    hint: "grace period to still jump just after walking off an edge",
  })
  coyoteMs = 110;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private groundedAt = -Infinity;
  private jumpHeld = false;

  create(): void {
    this.cursors = this.scene.input.keyboard!.createCursorKeys();
    // The director puts the player back here after a spike.
    this.scene.events.on("respawn-player", this.onRespawn, this);
  }

  update(_dt: number, time: number): void {
    const body = this.object.body as Phaser.Physics.Arcade.Body;
    if (!body) return;

    const left = this.cursors.left.isDown;
    const right = this.cursors.right.isDown;
    body.setVelocityX(left === right ? 0 : left ? -this.moveSpeed : this.moveSpeed);
    if (left !== right) this.object.setFlipX(left);

    if (body.blocked.down || body.touching.down) this.groundedAt = time;

    // Coyote time: a jump pressed just after the ledge still counts. Without
    // it the same input reads as "the game dropped my jump".
    const canJump = time - this.groundedAt <= this.coyoteMs;
    const pressed = this.cursors.up.isDown || this.cursors.space.isDown;
    if (pressed && !this.jumpHeld && canJump) {
      body.setVelocityY(this.jumpVelocity);
      this.groundedAt = -Infinity;
    }
    this.jumpHeld = pressed;
  }

  destroy(): void {
    this.scene.events.off("respawn-player", this.onRespawn, this);
  }

  private onRespawn(x: number, y: number): void {
    const body = this.object.body as Phaser.Physics.Arcade.Body;
    this.object.setPosition(x, y);
    body?.setVelocity(0, 0);
    this.groundedAt = -Infinity;
  }
}
`;

const COLLECTIBLE = `import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Attached to the Coin prefab, so every coin in every level shares one
 * behaviour. \`points\` is exposed on the prefab, which is what lets the Gold
 * variant be worth more without being a second kind of object.
 */
export class Collectible extends ScriptComponent {
  @property({ min: 1, max: 500, hint: "added to the score when taken" })
  points = 10;

  @property({ min: 0, max: 32, label: "bob height (px)" })
  bobHeight = 6;

  @property({ min: 0, max: 4, step: 0.1, label: "bob speed" })
  bobSpeed = 1.6;

  private baseY = 0;
  private taken = false;

  create(): void {
    this.baseY = this.object.y;
    const player = this.scene.children.getByName("Player");
    if (player) {
      this.scene.physics.add.overlap(this.object, player, () => this.take());
    }
  }

  update(_dt: number, time: number): void {
    if (this.taken) return;
    // A coin that sits perfectly still reads as scenery, not as a pickup.
    const phase = (time / 1000) * this.bobSpeed * Math.PI;
    this.object.setY(this.baseY + Math.sin(phase) * this.bobHeight);
  }

  private take(): void {
    if (this.taken) return;
    this.taken = true;
    this.scene.events.emit("coin-collected", this.points);
    this.object.destroy();
  }
}
`;

const HAZARD = `import { ScriptComponent, property } from "./ScriptComponent";

/**
 * Attached to the Spike prefab. It costs time rather than a life: a
 * hypercasual round should never end because of one mistake, it should just
 * get harder to win.
 */
export class Hazard extends ScriptComponent {
  @property({ min: 0, max: 15, label: "time penalty (s)" })
  timePenalty = 3;

  /** Stops one touch from firing on several consecutive frames. */
  private cooldown = 0;

  create(): void {
    const player = this.scene.children.getByName("Player");
    if (player) {
      this.scene.physics.add.overlap(this.object, player, () => this.hit());
    }
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  private hit(): void {
    if (this.cooldown > 0) return;
    this.cooldown = 900;
    this.scene.events.emit("player-hurt", this.timePenalty);
  }
}
`;

const GAME_DIRECTOR = `import Phaser from "phaser";
import { ScriptComponent, property } from "./ScriptComponent";

/**
 * The round itself: the clock, the score, the HUD and the ending.
 *
 * It is attached to the Spawn Point, which is also where the player is put
 * back after a spike — so the one object that means "here is where the round
 * starts" owns the rules of the round.
 *
 * Coins and spikes never call into this class. They emit a scene event and
 * this listens, so a coin does not need to know a score exists.
 */
export class GameDirector extends ScriptComponent {
  @property({ min: 5, max: 300, label: "round length (s)" })
  roundSeconds = 30;

  @property({ min: 1, max: 9999, label: "target score", hint: "score needed to win the round" })
  targetScore = 120;

  private score = 0;
  private remaining = 0;
  private over = false;
  private hud!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;

  create(): void {
    this.remaining = this.roundSeconds * 1000;

    // The spawn marker is an editing aid, not scenery: visible while you are
    // placing it, gone once the game runs.
    this.object.setVisible(false);

    // The HUD is AUTHORED, not built here. Where the score sits, how big it is
    // and whether it is pinned to the camera are content decisions, and they
    // live in the scene file with everything else. This just writes into it.
    this.hud = this.scene.children.getByName("HUD") as Phaser.GameObjects.Text;
    this.banner = this.scene.children.getByName("Banner") as Phaser.GameObjects.Text;

    this.scene.events.on("coin-collected", this.onCoin, this);
    this.scene.events.on("player-hurt", this.onHurt, this);
    this.draw();
  }

  update(dt: number): void {
    if (this.over) return;
    this.remaining = Math.max(0, this.remaining - dt);
    if (this.remaining === 0) this.finish();
    this.draw();
  }

  destroy(): void {
    this.scene.events.off("coin-collected", this.onCoin, this);
    this.scene.events.off("player-hurt", this.onHurt, this);
  }

  private onCoin(points: number): void {
    if (this.over) return;
    this.score += points;
    // Clearing the target early ends the round early — the reward for being
    // fast is getting to stop.
    if (this.score >= this.targetScore) this.finish();
  }

  private onHurt(penaltySeconds: number): void {
    if (this.over) return;
    this.remaining = Math.max(0, this.remaining - penaltySeconds * 1000);
    this.scene.cameras.main.shake(120, 0.006);
    this.scene.events.emit("respawn-player", this.object.x, this.object.y);
    if (this.remaining === 0) this.finish();
  }

  private finish(): void {
    this.over = true;
    const won = this.score >= this.targetScore;
    this.banner?.setText(won ? "ROUND CLEARED\\n" + this.score : "TIME UP\\n" + this.score);
  }

  private draw(): void {
    if (!this.hud) return;
    const seconds = (this.remaining / 1000).toFixed(1);
    this.hud.setText(\`SCORE \${this.score} / \${this.targetScore}    TIME \${seconds}\`);
  }
}
`;

export const GAME_SCRIPTS: GameScript[] = [
  {
    name: "RunnerController",
    role: "Moves the player: left, right, one jump with coyote time.",
    notes: [
      "Every value a player can feel — speed, jump, coyote time — is a @property, so the feel is tuned in the inspector and stored in the scene file, not recompiled.",
      "It listens for `respawn-player` rather than exposing a method, so nothing else needs a reference to it.",
    ],
    source: RUNNER_CONTROLLER,
  },
  {
    name: "Collectible",
    role: "Makes a coin bob, and turns a touch into points.",
    notes: [
      "Attached to the Coin PREFAB, so every coin in the level shares one behaviour and one place to change it.",
      "`points` is the field exposed to instances — the Gold variant raises it without being a second kind of object.",
      "It emits `coin-collected`; a coin does not need to know that a score exists.",
    ],
    source: COLLECTIBLE,
  },
  {
    name: "Hazard",
    role: "Costs the player time when touched.",
    notes: [
      "A spike takes seconds off the clock instead of ending the round — one mistake should make winning harder, not impossible.",
      "The cooldown stops a single touch from firing on several consecutive frames.",
    ],
    source: HAZARD,
  },
  {
    name: "GameDirector",
    role: "Owns the clock, the score, the HUD and the ending.",
    notes: [
      "Attached to the Spawn Point: the object that marks where a round starts also owns the rules of the round.",
      "It hides its own marker in create(), so the diamond is an editing aid rather than scenery.",
      "The HUD is not built here — it is two text objects authored in the scene, found by name. Where the score sits is a content decision.",
      "It is the only script that knows the score exists. Coins and spikes just emit events.",
    ],
    source: GAME_DIRECTOR,
  },
];
