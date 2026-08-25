import Phaser from "phaser";
import type { ScriptComponent } from "../../runtime/scripts";
import { platform } from "../platform";
import type { ScriptEntry } from "../platform/types";
import type { ScriptRegistry } from "./registry";

/**
 * Compiles the project's script classes and hands the play-test something it
 * can construct.
 *
 * The editor reads source statically everywhere else; this is the one place it
 * *runs* project code, and only when RUN is pressed on a project the user has
 * said yes to. The compile happens in the main process (rolldown), and the
 * result arrives as an IIFE that is evaluated here with the editor's own Phaser
 * passed in — so a script's `instanceof Phaser.Physics.Arcade.Sprite` is asked
 * against the same Phaser that built the sprite.
 */

export type ScriptCtor = new () => ScriptComponent;

export type RuntimeStatus = "idle" | "building" | "ready" | "error" | "untrusted";

const TRUST_KEY = "mosaic:trusted-scripts:v1";

/**
 * Trust is stored by the EDITOR, per folder — never in the project, where the
 * project itself could grant it.
 */
export function trustedRoots(): string[] {
  try {
    const raw = localStorage.getItem(TRUST_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

export function isTrusted(root: string | null | undefined): boolean {
  return !!root && trustedRoots().includes(root);
}

export function trustRoot(root: string): void {
  if (isTrusted(root)) return;
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify([...trustedRoots(), root]));
  } catch {
    /* a full quota means the ask comes back next time, which is the safe way to fail */
  }
}

export function revokeRoot(root: string): void {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify(trustedRoots().filter((r) => r !== root)));
  } catch {
    /* ignore */
  }
}

export class ScriptRuntime {
  status: RuntimeStatus = "idle";
  error: string | null = null;
  warnings: string[] = [];
  /** Class by `<src>::<class>`, ready for buildScene. */
  classes: Record<string, ScriptCtor> = {};
  /**
   * Classes the project wrote that prefabs are bound to, by prefab name.
   *
   * Compiled in the same bundle as the scripts rather than a second one: they
   * routinely import each other, and two bundles would give the play-test two
   * copies of any shared module.
   */
  prefabClasses: Record<string, new (...args: never[]) => Phaser.GameObjects.GameObject> = {};
  /** Project-relative paths that went into the last build. */
  modules: string[] = [];
  revision = 0;

  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.status = "idle";
    this.error = null;
    this.warnings = [];
    this.classes = {};
    this.prefabClasses = {};
    this.modules = [];
    this.emit();
  }

  /** True when an edit to this path invalidates the compiled bundle. */
  affectedBy(rels: string[]): boolean {
    return rels.some((rel) => this.modules.includes(rel));
  }

  /**
   * Compiles every component the index knows about — not just the ones this
   * scene attaches, because a script routinely reaches for a sibling class and
   * the bundle has to contain it.
   */
  async build(
    root: string,
    registry: ScriptRegistry,
    /** Prefab name -> the project class it is bound to. */
    bound: { prefab: string; src: string; className: string; exportName: string }[] = [],
  ): Promise<boolean> {
    if (!isTrusted(root)) {
      this.status = "untrusted";
      this.error = null;
      this.emit();
      return false;
    }
    const entries: ScriptEntry[] = [
      ...registry.attachable().map((cls) => ({ src: cls.src, className: cls.name })),
      ...bound.map((b) => ({ src: b.src, className: b.className, exportName: b.exportName })),
    ];
    if (!entries.length) {
      this.status = "ready";
      this.classes = {};
      this.prefabClasses = {};
      this.modules = [];
      this.emit();
      return true;
    }

    this.status = "building";
    this.error = null;
    this.emit();

    const bundle = await platform.bundleScripts(root, entries);
    this.warnings = bundle.warnings;
    if (!bundle.code) {
      // The last good build is kept, the way the index keeps the last good
      // metadata: a typo mid-edit should not empty the running scene.
      this.status = "error";
      this.error = bundle.error ?? "the scripts did not compile";
      this.emit();
      return false;
    }

    try {
      this.classes = evaluateBundle(bundle.code);
      // The bundle is keyed by `<src>::<class>`; prefabs are looked up by name.
      const byPrefab: Record<string, new (...args: never[]) => Phaser.GameObjects.GameObject> = {};
      for (const b of bound) {
        const cls = (this.classes as Record<string, unknown>)[`${b.src}::${b.className}`];
        if (cls) byPrefab[b.prefab] = cls as new (...args: never[]) => Phaser.GameObjects.GameObject;
      }
      this.prefabClasses = byPrefab;
      this.modules = bundle.modules;
      this.status = "ready";
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.emit();
    return this.status === "ready";
  }
}

/**
 * Runs the compiled IIFE with the editor's Phaser in scope.
 *
 * This is `new Function`, and deliberately so: the bundle is the user's own
 * game code, compiled from the folder they opened and gated on their consent —
 * the same trust they extend to their dev server. It is not a sandbox, and
 * nothing here pretends otherwise.
 */
function evaluateBundle(code: string): Record<string, ScriptCtor> {
  // Two names for the same instance, deliberately.
  //
  // `__mosaicPhaser` is what the bundler maps `import Phaser from "phaser"` on
  // to. But a project written against a script tag — which is how the Phaser
  // examples and a lot of real games are written — never imports it and just
  // says `Phaser`, so that identifier has to resolve in this scope too.
  // Passing it as a parameter keeps it out of `window`, where it would leak
  // into the editor's own globals.
  const factory = new Function(
    "__mosaicPhaser",
    "Phaser",
    `${code}\nreturn MosaicScripts;`,
  ) as (
    phaser: unknown,
    globalPhaser: unknown,
  ) => { default?: Record<string, ScriptCtor> } | Record<string, ScriptCtor>;

  const exported = factory(Phaser, Phaser);
  const map = (exported as { default?: Record<string, ScriptCtor> }).default ?? exported;
  return map as Record<string, ScriptCtor>;
}
