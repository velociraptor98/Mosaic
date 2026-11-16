import type Phaser from "phaser";

/**
 * Script components — the behaviour half of a scene object.
 *
 * This file ships INSIDE your game: Mosaic copies it into
 * `src/scripts/ScriptComponent.ts` when it scaffolds a project, and the classes
 * you write extend the `ScriptComponent` below. The editor never runs your
 * code — it reads this file's `@property` declarations out of your source and
 * renders them, and the values you author land in the scene JSON. The class is
 * the source of truth for what exists; the scene is the source of truth for
 * what it is set to.
 *
 *   export class PlayerController extends ScriptComponent {
 *     @property({ min: 0, max: 600 })
 *     moveSpeed = 180;
 *
 *     update(dt: number) { ... }
 *   }
 *
 * Nothing here imports Phaser at runtime — only its types — so this module is
 * safe to load anywhere.
 */

export type PropertyType =
  | "number"
  | "string"
  | "boolean"
  | "enum"
  | "object"
  | "function"
  | "ref";

export interface PropertyOptions {
  /** Shown in the inspector instead of the field name. */
  label?: string;
  /** Usually inferred from the initialiser; set it when inference cannot. */
  type?: PropertyType;
  min?: number;
  max?: number;
  step?: number;
  /** Choices for an enum field. */
  options?: string[];
  /** One-line note rendered under the field. */
  hint?: string;
}

export interface PropertyMeta extends PropertyOptions {
  name: string;
}

/** Declarations per constructor. A subclass inherits its parent's list. */
const DECLARED = new Map<unknown, PropertyMeta[]>();

function declare(owner: unknown, name: string, options: PropertyOptions): void {
  const list = DECLARED.get(owner) ?? [];
  const existing = list.findIndex((p) => p.name === name);
  const meta: PropertyMeta = { ...options, name };
  if (existing >= 0) list[existing] = meta;
  else list.push(meta);
  DECLARED.set(owner, list);
}

/**
 * Marks a field as editable in Mosaic. Everything else on the class stays
 * private: the inspector is a list of what you exposed, not a live object dump.
 *
 * Works under both decorator dialects — TypeScript's `experimentalDecorators`
 * (what today's bundlers transform) and the standard ES decorators — because a
 * project should not have to pick one for the editor to read its properties.
 */
export function property(options: PropertyOptions = {}) {
  // The return type is `any` on purpose. TypeScript's legacy decorators
  // require a property decorator to return void or any and reject `unknown`
  // outright, while the standard dialect wants the field's initialiser back —
  // one signature has to satisfy both, and this is the only one that does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function decorate(a: unknown, b: unknown): any {
    // Standard decorators: (value, context).
    if (b && typeof b === "object" && "kind" in (b as Record<string, unknown>)) {
      const ctx = b as {
        kind: string;
        name: string | symbol;
        addInitializer(fn: (this: unknown) => void): void;
      };
      if (ctx.kind === "field" || ctx.kind === "accessor") {
        // `this` is the instance, so its constructor is the owner the
        // registry is keyed by — which is what makes subclassing work.
        ctx.addInitializer(function (this: unknown) {
          declare((this as { constructor: unknown }).constructor, String(ctx.name), options);
        });
      }
      return a;
    }
    // Legacy decorators: (prototype, key).
    if (a && typeof b === "string") {
      declare((a as { constructor?: unknown }).constructor ?? a, b, options);
    }
    return undefined;
  };
}

/** Every property declared on a constructor and its bases, base-first. */
export function declaredProperties(ctor: unknown): PropertyMeta[] {
  const chain: unknown[] = [];
  for (let c = ctor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c);
  const out: PropertyMeta[] = [];
  for (const link of chain) {
    for (const meta of DECLARED.get(link) ?? []) {
      const at = out.findIndex((p) => p.name === meta.name);
      if (at >= 0) out[at] = meta;
      else out.push(meta);
    }
  }
  return out;
}

/**
 * The base class for behaviour. Subclass it, declare what the editor may set,
 * and implement whichever of create / update / destroy you need.
 */
export abstract class ScriptComponent<
  T extends Phaser.GameObjects.GameObject = Phaser.GameObjects.Sprite,
> {
  /** Set by the host before create() runs. */
  scene!: Phaser.Scene;
  object!: T;
  /** False when the editor disabled this script: create/update are skipped. */
  enabled = true;

  /** Called once, on the first update after the whole scene is built. */
  create?(): void;
  /** dt is milliseconds, matching Phaser's own update signature. */
  update?(dt: number, time: number): void;
  /**
   * Called when this object touches something, with the thing it touched.
   *
   * Nothing calls this by itself. Colliders are your scene's code, and the
   * one that should reach its objects' scripts says so:
   *
   *   this.physics.add.collider(ball, groups.brick, (a, b) =>
   *     scripts.contact(a, b, "collide"));
   *
   * That keeps one collider per pair — the one doing the physics is the one
   * that reports it — and lets behaviour written on a prefab's script reach
   * every instance without the scene naming any of them.
   */
  onContact?(other: Phaser.GameObjects.GameObject, rule: "collide" | "overlap"): void;
  destroy?(): void;
}

export type ScriptClass<T extends ScriptComponent = ScriptComponent> = new () => T;

interface Attachment {
  script: ScriptComponent;
  started: boolean;
}

/**
 * One participant in a collision, as Arcade's own callback hands it over.
 *
 * Taken FROM Phaser's alias rather than spelled out: the union has widened
 * between versions, and the generated scene passes these straight through, so
 * writing it by hand here would break against whichever Phaser a project pins.
 */
export type ContactSide = Parameters<Phaser.Types.Physics.Arcade.ArcadePhysicsCallback>[0];

/**
 * Runs the scripts attached to a scene's objects.
 *
 * One host per scene owns the update loop, so scripts run in the order they
 * were attached — which is the order the editor's list shows, because that
 * list is what the generated code walks.
 */
export class ScriptHost {
  /**
   * Called when a script throws. The script is disabled either way — one
   * broken behaviour should not take the frame loop with it — and the editor
   * uses this to say which one, and where.
   */
  onError: ((info: { script: ScriptComponent; error: unknown }) => void) | null = null;

  private attachments: Attachment[] = [];
  private byObject = new Map<Phaser.GameObjects.GameObject, ScriptComponent[]>();
  /** Scripts whose create() has run. A contact before that is dropped. */
  private started = new WeakSet<ScriptComponent>();
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    scene.events.on("update", this.tick, this);
    scene.events.once("shutdown", this.dispose, this);
    scene.events.once("destroy", this.dispose, this);
  }

  /**
   * Attaches one script. Values are applied before create() so a script never
   * sees its declared default when the scene set something else.
   *
   * A disabled script is still constructed and still has its values applied —
   * only create/update are skipped — so re-enabling it at runtime just works.
   */
  add<T extends ScriptComponent>(
    object: Phaser.GameObjects.GameObject,
    script: T,
    props: Record<string, unknown> = {},
    enabled = true,
  ): T {
    script.scene = this.scene;
    (script as ScriptComponent<Phaser.GameObjects.GameObject>).object = object;
    script.enabled = enabled;
    for (const [key, value] of Object.entries(props)) {
      (script as unknown as Record<string, unknown>)[key] = value;
    }
    this.attachments.push({ script, started: false });
    const list = this.byObject.get(object) ?? [];
    list.push(script);
    this.byObject.set(object, list);
    // Destroying the object takes its scripts with it.
    object.once("destroy", () => this.remove(object));
    return script;
  }

  /** The scripts on an object, in execution order. */
  for(object: Phaser.GameObjects.GameObject): ScriptComponent[] {
    return this.byObject.get(object) ?? [];
  }

  /**
   * Tells both objects in a pair that they touched. Call it from a collider
   * or overlap callback; each side is handed the OTHER object, so a script
   * never has to work out which of the two it was.
   */
  contact(a: ContactSide, b: ContactSide, rule: "collide" | "overlap"): void {
    this.deliver(a, b, rule);
    this.deliver(b, a, rule);
  }

  /**
   * Both sides are cast to GameObject here, once, so a script's `onContact`
   * gets the type it actually wants. A script lives on a game object, so a
   * participant that is a Tile has nothing to deliver to and is skipped.
   */
  private deliver(
    rawObject: ContactSide,
    rawOther: ContactSide,
    rule: "collide" | "overlap",
  ): void {
    const object = rawObject as Phaser.GameObjects.GameObject;
    const other = rawOther as Phaser.GameObjects.GameObject;
    // A copy: a handler may destroy its own object, which takes its scripts
    // out of the list we would otherwise still be walking.
    for (const script of [...(this.byObject.get(object) ?? [])]) {
      // Physics runs before this host's tick, so the very first contact of a
      // scene can land before create() has. A script that has not initialised
      // has no business handling an event.
      if (!script.enabled || !script.onContact || !this.started.has(script)) continue;
      try {
        script.onContact(other, rule);
      } catch (error) {
        script.enabled = false;
        if (this.onError) this.onError({ script, error });
        else console.error("[mosaic] script disabled after an error in onContact", error);
      }
    }
  }

  /** The first script of a given class on an object. */
  get<T extends ScriptComponent>(
    object: Phaser.GameObjects.GameObject,
    ctor: new (...args: never[]) => T,
  ): T | undefined {
    return this.for(object).find((s): s is T => s instanceof ctor);
  }

  remove(object: Phaser.GameObjects.GameObject): void {
    const list = this.byObject.get(object);
    if (!list) return;
    this.byObject.delete(object);
    for (const script of list) {
      script.destroy?.();
      const at = this.attachments.findIndex((a) => a.script === script);
      if (at >= 0) this.attachments.splice(at, 1);
    }
  }

  private tick(time: number, delta: number): void {
    // create() is deferred to the first tick rather than run at attach time:
    // scripts routinely look up other objects, and at attach time the rest of
    // the scene does not exist yet.
    for (const attachment of this.attachments) {
      if (!attachment.script.enabled) continue;
      try {
        if (!attachment.started) {
          attachment.started = true;
          this.started.add(attachment.script);
          attachment.script.create?.();
        }
        attachment.script.update?.(delta, time);
      } catch (error) {
        // Switched off rather than left to throw sixty times a second. The
        // scene keeps running, and whoever is watching gets told which script
        // stopped and why.
        attachment.script.enabled = false;
        if (this.onError) this.onError({ script: attachment.script, error });
        else console.error("[mosaic] script disabled after an error", error);
      }
    }
  }

  private dispose(): void {
    this.scene.events.off("update", this.tick, this);
    for (const attachment of this.attachments) attachment.script.destroy?.();
    this.attachments = [];
    this.byObject.clear();
  }
}
