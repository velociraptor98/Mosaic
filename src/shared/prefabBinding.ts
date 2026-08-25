import type { PrefabSource } from "./types";

/**
 * Whether a project class can be constructed from a scene snapshot, and how.
 *
 * A snapshot knows where an object is, what it is called and what it draws with.
 * It does not know what a `track`, a `speed` or a `config` is, and guessing
 * would generate a call that compiles and then behaves wrongly. So the rule is
 * strict: every parameter must be one this vocabulary can fill, or the class is
 * not bound at all and the object imports as a plain sprite.
 *
 * Measured against the Phaser examples this binds roughly half the classes —
 * `Door(name, scene, x, y)` and `EnemySnowball(scene, x, y, key, frame)` yes,
 * `Snowman(scene, track, size)` no. Refusing the other half loudly is worth
 * more than binding it wrongly and quietly.
 */
export type BindArg =
  | { kind: "scene" }
  | { kind: "x" }
  | { kind: "y" }
  | { kind: "name" }
  | { kind: "texture" }
  | { kind: "frame" };

const VOCABULARY: Record<string, BindArg["kind"]> = {
  scene: "scene",
  x: "x",
  y: "y",
  name: "name",
  key: "texture",
  texture: "texture",
  frame: "frame",
};

/** The argument plan for a constructor, or null when it cannot be satisfied. */
export function bindArgs(params: string[]): BindArg[] | null {
  const out: BindArg[] = [];
  for (const p of params) {
    const kind = VOCABULARY[p.toLowerCase()];
    if (!kind) return null;
    out.push({ kind } as BindArg);
  }
  return out;
}

/** Why a class could not be bound, for the import's issue list. */
export function unbindableParams(params: string[]): string[] {
  return params.filter((p) => !VOCABULARY[p.toLowerCase()]);
}

export function canBind(source: PrefabSource | undefined): boolean {
  return !!source && bindArgs(source.params) !== null;
}

/** What a caller knows about the instance it is constructing. */
export interface BindContext {
  scene: unknown;
  x: number;
  y: number;
  name: string;
  texture: string;
  frame: string;
}

/**
 * The runtime argument list for a bound constructor.
 *
 * The exporter turns the same plan into source text. Both go through
 * `bindArgs`, so a parameter the generated code fills one way cannot be filled
 * another way by the play-test — which would show one thing in the editor and
 * ship another.
 */
export function boundArgValues(plan: BindArg[], ctx: BindContext): unknown[] {
  return plan.map((arg) => {
    switch (arg.kind) {
      case "scene":
        return ctx.scene;
      case "x":
        return ctx.x;
      case "y":
        return ctx.y;
      case "name":
        return ctx.name;
      case "texture":
        return ctx.texture;
      case "frame":
        return ctx.frame;
    }
  });
}
