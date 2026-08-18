import Phaser from "phaser";
import { buildScene } from "../../runtime/loadScene";
import { setPath } from "../../shared/prefabs";
import type { ProjectData, SceneData } from "../../shared/types";
import type { EditorBridge } from "../bridge";
import type { ScriptCtor } from "../scripts/runtime";
import type { ScriptHost } from "../../runtime/scripts";

export interface PlaySceneInit {
  project: ProjectData;
  scene: SceneData;
  bridge: EditorBridge;
  debug: boolean;
  /**
   * The project's compiled script classes. Absent when the project has none,
   * when they did not compile, or when the user has not trusted this folder —
   * in every one of those cases the scene still runs, without behaviour.
   */
  scripts?: Record<string, ScriptCtor>;
}

/**
 * Play-test runs the real runtime builder (src/runtime/loadScene.ts) — the
 * same code a shipped game calls — inside the canvas you were just editing.
 * No export step, no second window, no reload.
 */
export class PlayScene extends Phaser.Scene {
  private project!: ProjectData;
  private sceneData!: SceneData;
  private bridge!: EditorBridge;
  private debug = true;
  private scripts?: Record<string, ScriptCtor>;
  private host: ScriptHost | null = null;
  /** Scripts that threw and were switched off, for the status bar. */
  scriptErrors: { script: string; message: string }[] = [];

  private objects = new Map<string, Phaser.GameObjects.Sprite>();
  private player: Phaser.Physics.Arcade.Sprite | null = null;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;

  paused = false;
  frame = 0;
  /** Runtime-only edits, so `stop` can offer to promote them into the scene. */
  volatile = new Map<string, Record<string, unknown>>();

  constructor() {
    super("PlayScene");
  }

  init(data: PlaySceneInit): void {
    this.project = data.project;
    this.sceneData = data.scene;
    this.bridge = data.bridge;
    this.debug = data.debug;
    this.scripts = data.scripts;
    this.scriptErrors = [];
    this.paused = false;
    this.frame = 0;
    this.volatile.clear();
  }

  create(): void {
    const s = this.sceneData.settings;
    this.cameras.main.setBackgroundColor(s.backgroundColor);
    this.cameras.main.setScroll(0, 0);
    this.cameras.main.setZoom(1);
    this.physics.world.setBounds(0, 0, s.width, s.height);
    this.physics.world.gravity.y = s.gravityY;

    const built = buildScene(this, this.project, this.sceneData, {
      physics: true,
      scripts: this.scripts,
    });
    this.objects = built.objectsById;
    this.host = built.scripts;

    // A script that throws is disabled rather than allowed to take the run
    // down; the editor says which one, once, rather than every frame.
    if (this.host) {
      this.host.onError = ({ script, error }) => {
        const name = script.constructor?.name ?? "script";
        const message = error instanceof Error ? error.message : String(error);
        this.scriptErrors.push({ script: name, message });
        this.bridge.send("scriptError", { script: name, message });
        console.error(`[mosaic] ${name} threw and was disabled`, error);
      };
    }

    // Debug draw runs in the same view as the editor, so a body that is wrong
    // by four pixels is obvious rather than inferred from behaviour.
    this.physics.world.drawDebug = this.debug;
    if (this.debug && !this.physics.world.debugGraphic) this.physics.world.createDebugGraphic();
    if (this.physics.world.debugGraphic) {
      this.physics.world.debugGraphic.setVisible(this.debug).setDepth(99999);
    }

    for (const [id, sprite] of this.objects) {
      const obj = this.sceneData.objects.find((o) => o.id === id);
      if (obj?.type === "player") this.player = sprite as Phaser.Physics.Arcade.Sprite;
      sprite.setInteractive();
      sprite.on("pointerdown", () => this.bridge.send("runtimeSelection", id));
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;

    this.game.registry.set("playScene", this);
    this.emitState();
  }

  update(): void {
    if (this.paused) return;
    this.frame += 1;
    this.drivePlayer();
  }

  /** A default controller, so pressing RUN actually plays something. */
  private drivePlayer(): void {
    const player = this.player;
    if (!player?.body) return;
    const obj = [...this.objects.entries()].find(([, s]) => s === player);
    const data = obj ? this.sceneData.objects.find((o) => o.id === obj[0]) : null;
    const speed = Number(data?.data.speed ?? 200);
    const jump = Number(data?.data.jump ?? 420);
    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const down = this.cursors.down.isDown || this.wasd.S.isDown;

    player.setVelocityX(left ? -speed : right ? speed : 0);
    if (this.sceneData.settings.gravityY > 0) {
      const onFloor = (player.body as Phaser.Physics.Arcade.Body).blocked.down;
      if (up && onFloor) player.setVelocityY(-jump);
    } else {
      player.setVelocityY(up ? -speed : down ? speed : 0);
    }
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  pauseRun(): void {
    this.paused = true;
    this.physics.world.pause();
    this.anims.pauseAll();
    this.emitState();
  }

  resumeRun(): void {
    this.paused = false;
    this.physics.world.resume();
    this.anims.resumeAll();
    this.emitState();
  }

  /** Advance exactly one update — how a collision bug gets diagnosed. */
  stepFrame(): void {
    if (!this.paused) this.pauseRun();
    this.physics.world.resume();
    this.drivePlayer();
    this.physics.world.step(1 / 60);
    this.physics.world.pause();
    this.frame += 1;
    this.emitState();
  }

  // -------------------------------------------------------------------
  // Live inspection
  // -------------------------------------------------------------------

  /** Inspector writes during play apply immediately and are marked volatile. */
  setRuntimeProp(id: string, path: string, value: unknown): void {
    const sprite = this.objects.get(id);
    if (!sprite) return;
    switch (path) {
      case "x":
        sprite.x = Number(value);
        break;
      case "y":
        sprite.y = Number(value);
        break;
      case "rotation":
        sprite.setAngle(Number(value));
        break;
      case "scaleX":
        sprite.setScale(Number(value), sprite.scaleY);
        break;
      case "scaleY":
        sprite.setScale(sprite.scaleX, Number(value));
        break;
      case "visible":
        sprite.setVisible(Boolean(value));
        break;
      default:
        if (path.startsWith("data.")) sprite.setData(path.slice(5), value);
        else if (path === "body.immovable") {
          (sprite.body as Phaser.Physics.Arcade.Body)?.setImmovable(Boolean(value));
        } else return;
    }
    const bucket = this.volatile.get(id) ?? {};
    bucket[path] = value;
    this.volatile.set(id, bucket);
    this.emitState();
  }

  readRuntime(id: string): Record<string, unknown> | null {
    const sprite = this.objects.get(id);
    if (!sprite) return null;
    const body = sprite.body as Phaser.Physics.Arcade.Body | null;
    return {
      x: Math.round(sprite.x * 100) / 100,
      y: Math.round(sprite.y * 100) / 100,
      rotation: Math.round(sprite.angle * 100) / 100,
      scaleX: sprite.scaleX,
      scaleY: sprite.scaleY,
      visible: sprite.visible,
      velocityX: body ? Math.round(body.velocity.x) : null,
      velocityY: body ? Math.round(body.velocity.y) : null,
      onFloor: body ? body.blocked.down : null,
    };
  }

  /** Volatile edits as {objectId -> {path -> value}} for the promote prompt. */
  volatileEdits(): { id: string; path: string; value: unknown }[] {
    const out: { id: string; path: string; value: unknown }[] = [];
    for (const [id, paths] of this.volatile) {
      for (const [path, value] of Object.entries(paths)) out.push({ id, path, value });
    }
    return out;
  }

  applyTo(target: Record<string, unknown>, path: string, value: unknown): void {
    setPath(target, path, value);
  }

  private emitState(): void {
    this.bridge.send("playtest", { playing: true, paused: this.paused, frame: this.frame });
  }
}
