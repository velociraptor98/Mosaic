import Phaser from "phaser";

import { buildScene, preloadProject } from "../../src/runtime/loadScene";
import type { ProjectData, SceneData } from "../../src/shared/types";

/**
 * Scene parity: the loader path and the generated path, side by side.
 *
 * Scene semantics are implemented twice — once in `runtime/loadScene.ts`, which
 * the editor's play-test uses, and once in the code generator, which is what
 * ships. Only the first was ever executed: the generated code was typechecked
 * and bundled but never run, so the two could drift apart silently. They did,
 * twice, and both times the symptom was the same — the editor showed behaviour
 * the shipped game did not have.
 *
 * This boots the SAME scene both ways in one page and diffs what a running
 * scene can be asked about. It asserts agreement, not correctness: a field both
 * paths get wrong together still reads as parity, and a thing neither path
 * constructs is invisible to it. What it does catch is drift, which is the
 * failure mode that actually happened.
 */

export interface Reading {
  /**
   * Every animation key the scene registered. The generated scene once
   * registered only those a scene object named in playOnSpawn, so an animation
   * a script played existed in the play-test and not in the build.
   */
  animKeys: string[];
  /** key:repeat:yoyo:frames for each animation, so config drift is visible. */
  animConfig: string[];
  gravityY: number;
  boundsWidth: number;
  boundsHeight: number;
  background: string;
  colliders: number;
  objects: Record<string, ObjectReading>;
}

export interface ObjectReading {
  x: number;
  y: number;
  depth: number;
  visible: boolean;
  scaleX: number;
  scaleY: number;
  angle: number;
  originX: number;
  originY: number;
  texture: string | null;
  /** Null when the object has no arcade body. */
  body: BodyReading | null;
  /** Text objects only. */
  text: string | null;
  scrollFactorX: number;
  /** The animation currently on the object, and whether it is running. */
  anim: string | null;
  animPlaying: boolean;
  /** The frame being shown, so a played animation is distinguishable from a pose. */
  frame: string | null;
}

export interface BodyReading {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  immovable: boolean;
  allowGravity: boolean;
  bounceX: number;
  collideWorldBounds: boolean;
  isCircle: boolean;
  radius: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function readBody(obj: Phaser.GameObjects.GameObject): BodyReading | null {
  const body = (obj as { body?: Phaser.Physics.Arcade.Body }).body;
  if (!body || typeof body.setCollideWorldBounds !== "function") return null;
  return {
    width: round(body.width),
    height: round(body.height),
    offsetX: round(body.offset.x),
    offsetY: round(body.offset.y),
    immovable: body.immovable,
    allowGravity: body.allowGravity,
    bounceX: round(body.bounce.x),
    collideWorldBounds: body.collideWorldBounds,
    isCircle: body.isCircle,
    radius: round(body.radius),
  };
}

/** Everything a booted scene can be asked about, keyed by object name. */
export function read(scene: Phaser.Scene): Reading {
  const objects: Record<string, ObjectReading> = {};
  for (const child of scene.children.list) {
    const named = child as Phaser.GameObjects.Sprite;
    if (!named.name) continue;
    objects[named.name] = {
      x: round(named.x),
      y: round(named.y),
      depth: round(named.depth),
      visible: named.visible,
      scaleX: round(named.scaleX ?? 1),
      scaleY: round(named.scaleY ?? 1),
      angle: round(named.angle ?? 0),
      originX: round(named.originX ?? 0),
      originY: round(named.originY ?? 0),
      texture: named.texture?.key ?? null,
      body: readBody(child),
      text: (child as unknown as Phaser.GameObjects.Text).text ?? null,
      scrollFactorX: round(named.scrollFactorX ?? 1),
      anim: named.anims?.currentAnim?.key ?? null,
      animPlaying: !!named.anims?.isPlaying,
      frame: named.frame?.name != null ? String(named.frame.name) : null,
    };
  }

  const world = scene.physics?.world;
  const registry = (scene.anims as unknown as { anims?: { entries?: Record<string, unknown> } })
    ?.anims?.entries;
  return {
    animKeys: registry ? Object.keys(registry).sort() : [],
    animConfig: registry
      ? Object.entries(registry)
          .map(([key, a]) => {
            const anim = a as { repeat?: number; yoyo?: boolean; frames?: unknown[] };
            return `${key}:r${anim.repeat}:y${anim.yoyo ? 1 : 0}:f${anim.frames?.length ?? 0}`;
          })
          .sort()
      : [],
    gravityY: round(world?.gravity.y ?? 0),
    boundsWidth: round(world?.bounds.width ?? 0),
    boundsHeight: round(world?.bounds.height ?? 0),
    background: (scene.cameras?.main?.backgroundColor?.rgba ?? "").toString(),
    // Phaser keeps colliders on the world; the count is a cheap proxy for
    // "the collision matrix was wired the same way".
    colliders: (world as unknown as { colliders?: { _active?: unknown[] } })?.colliders?._active
      ?.length ?? 0,
    objects,
  };
}

/**
 * Reads a scene one frame after it was built.
 *
 * Not in `create()`: Phaser settles parts of a physics body on its first
 * update, so a synchronous read reports a body that has not finished becoming
 * itself. One frame in is also closer to the question actually being asked —
 * what does the game look like once it is running.
 */
export function readAfterFrame(scene: Phaser.Scene, onReady: (reading: Reading) => void): void {
  scene.events.once("postupdate", () => onReady(read(scene)));
}

/**
 * Boots one scene from the LOADER, the path the play-test runs. The generated
 * path is booted by the harness page, which imports the generated class the
 * exporter wrote.
 */
export function bootLoaderScene(
  project: ProjectData,
  data: SceneData,
  onReady: (reading: Reading) => void,
): Phaser.Game {
  class LoaderScene extends Phaser.Scene {
    constructor() {
      super("LoaderScene");
    }
    preload(): void {
      preloadProject(this, project, data);
    }
    create(): void {
      buildScene(this, project, data, { physics: true });
      readAfterFrame(this, onReady);
    }
  }

  return new Phaser.Game({
    type: Phaser.CANVAS,
    width: data.settings.width,
    height: data.settings.height,
    physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    scene: [LoaderScene],
    audio: { noAudio: true },
  });
}

/**
 * Differences between two readings, as dotted paths. An empty list is parity.
 *
 * Positions are compared with a small tolerance: the two paths round at
 * different points and a sub-pixel difference is not drift.
 */
export function diff(loader: Reading, generated: Reading): string[] {
  const out: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.51;

  const scalar = (key: keyof Reading) => {
    const a = loader[key];
    const b = generated[key];
    if (typeof a === "number" && typeof b === "number") {
      if (!near(a, b)) out.push(`scene.${key}: loader=${a} generated=${b}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`scene.${key}: loader=${JSON.stringify(a)} generated=${JSON.stringify(b)}`);
    }
  };
  scalar("animKeys");
  scalar("animConfig");
  scalar("gravityY");
  scalar("boundsWidth");
  scalar("boundsHeight");
  scalar("background");

  const names = new Set([...Object.keys(loader.objects), ...Object.keys(generated.objects)]);
  for (const name of [...names].sort()) {
    const a = loader.objects[name];
    const b = generated.objects[name];
    if (!a) {
      out.push(`${name}: built by the generated scene only`);
      continue;
    }
    if (!b) {
      out.push(`${name}: built by the loader only`);
      continue;
    }
    for (const key of Object.keys(a) as (keyof ObjectReading)[]) {
      if (key === "body") continue;
      // Phaser mints a private texture per Text object, so the keys are random
      // by design. The text itself is what has to match.
      if (key === "texture" && (a.text !== null || b.text !== null)) continue;
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") {
        if (!near(av, bv)) out.push(`${name}.${key}: loader=${av} generated=${bv}`);
      } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
        out.push(`${name}.${key}: loader=${JSON.stringify(av)} generated=${JSON.stringify(bv)}`);
      }
    }
    if (!a.body !== !b.body) {
      out.push(`${name}.body: loader=${a.body ? "present" : "none"} generated=${b.body ? "present" : "none"}`);
      continue;
    }
    if (a.body && b.body) {
      for (const key of Object.keys(a.body) as (keyof BodyReading)[]) {
        const av = a.body[key];
        const bv = b.body[key];
        if (typeof av === "number" && typeof bv === "number") {
          if (!near(av, bv)) out.push(`${name}.body.${key}: loader=${av} generated=${bv}`);
        } else if (av !== bv) {
          out.push(`${name}.body.${key}: loader=${av} generated=${bv}`);
        }
      }
    }
  }
  return out;
}
