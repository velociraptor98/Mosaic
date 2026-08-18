import baseSource from "../../runtime/scripts.ts?raw";
import { SCRIPT_BASE_CLASS } from "../../shared/scripts";

/**
 * The two files a project needs before a script can exist: the base class, and
 * the stub "Create script…" writes.
 *
 * The base class is not a template string — it is `src/runtime/scripts.ts`,
 * imported verbatim. One copy, type-checked in this repo, shipped into yours,
 * so what the editor parses and what your game runs cannot drift apart.
 */

export function scriptBaseSource(): string {
  return baseSource;
}

/** Written by "Create script…", and by the New Project flow as a worked example. */
export function scriptStub(className: string, importPath = `./${SCRIPT_BASE_CLASS}`): string {
  return `import { ${SCRIPT_BASE_CLASS}, property } from "${importPath}";

/**
 * Attached to objects in Mosaic. Fields marked @property show up in the
 * inspector; everything else on the class stays private to your code.
 */
export class ${className} extends ${SCRIPT_BASE_CLASS} {
  @property({ min: 0, max: 1000 })
  speed = 100;

  @property({ label: "start active" })
  active = true;

  create(): void {
    // Runs once, after the whole scene exists.
  }

  update(dt: number): void {
    if (!this.active) return;
    void dt;
  }
}
`;
}

/** The sample script a new project opens with, referenced by its template. */
export function samplePlayerController(importPath = `./${SCRIPT_BASE_CLASS}`): string {
  return `import Phaser from "phaser";
import { ${SCRIPT_BASE_CLASS}, property } from "${importPath}";

/**
 * A worked example: every field below is editable in Mosaic, and the values
 * you set there live in the scene file, not in this class.
 */
export class PlayerController extends ${SCRIPT_BASE_CLASS} {
  @property({ min: 0, max: 600 })
  moveSpeed = 180;

  @property()
  jumpVelocity = -420;

  @property({ label: "coyote time (ms)", min: 0, max: 500 })
  coyoteMs = 120;

  @property()
  doubleJump = false;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private lastGrounded = 0;
  private jumpsLeft = 0;

  create(): void {
    this.cursors = this.scene.input.keyboard!.createCursorKeys();
  }

  update(dt: number, time: number): void {
    void dt;
    const sprite = this.object as Phaser.Physics.Arcade.Sprite;
    const body = sprite.body as Phaser.Physics.Arcade.Body | null;
    if (!body) return;

    const left = this.cursors.left.isDown;
    const right = this.cursors.right.isDown;
    sprite.setVelocityX(left ? -this.moveSpeed : right ? this.moveSpeed : 0);

    if (body.blocked.down) {
      this.lastGrounded = time;
      this.jumpsLeft = this.doubleJump ? 2 : 1;
    }

    // Coyote time: a jump pressed just after walking off an edge still counts.
    const grounded = time - this.lastGrounded <= this.coyoteMs;
    if (Phaser.Input.Keyboard.JustDown(this.cursors.up) && (grounded || this.jumpsLeft > 0)) {
      sprite.setVelocityY(this.jumpVelocity);
      this.jumpsLeft -= 1;
    }
  }
}
`;
}

/** Class names must be a valid identifier, because they become one. */
export function isValidClassName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** "player controller" -> "PlayerController" */
export function toClassName(input: string): string {
  const cleaned = input.replace(/[^\w$]+(.)?/g, (_m, next: string | undefined) =>
    next ? next.toUpperCase() : "",
  );
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
}
