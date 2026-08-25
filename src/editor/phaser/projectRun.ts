import Phaser from "phaser";
import { platform } from "../platform";
import { isTrusted } from "../scripts/runtime";

/**
 * Runs the project's OWN game inside the editor.
 *
 * Play-test builds a scene from Mosaic's data and runs Mosaic's runtime. That
 * is the right thing for a project Mosaic authored, and the wrong thing for one
 * it imported: an existing game's behaviour — its update loop, its input, its
 * timers — lives in a scene class Mosaic does not own and never calls. So this
 * does the opposite. It compiles the project's entry point, takes the scene
 * classes the game was constructed with, and runs those.
 *
 * What the editor contributes is the objects. A project whose `create()` calls
 * the generated builder gets both: its own behaviour, and the scene as edited.
 * One that does not still runs — it just runs exactly as it would without
 * Mosaic, which is a useful thing to be able to see.
 *
 * The entry is evaluated with `Phaser.Game` stubbed, because that constructor
 * is where a Phaser project states everything: its scene list, its canvas size,
 * its physics. Catching it is exact where parsing the config object would be
 * guesswork, and it stops the project booting a second game of its own inside
 * the one the editor already has.
 */

export interface ProjectRunResult {
  ok: boolean;
  error?: string;
  /** Scene keys registered from the project, in the order its config listed them. */
  keys?: string[];
  /** The key actually started. */
  started?: string;
}

interface CapturedConfig {
  scene?: unknown;
  width?: number;
  height?: number;
  backgroundColor?: string | number;
  physics?: unknown;
}

/** Scene classes registered by a previous run, so a re-run replaces them. */
const registered = new Map<Phaser.Game, string[]>();

function evaluateEntry(code: string): CapturedConfig | null {
  let captured: CapturedConfig | null = null;

  // A stub that records rather than constructs. The project's entry runs at
  // module scope, so this has to be in place before the code is evaluated.
  class GameStub {
    constructor(config: CapturedConfig) {
      captured = config;
    }
    scene = { add() {}, start() {} };
  }

  const patched = new Proxy(Phaser, {
    get(target, prop, receiver) {
      if (prop === "Game") return GameStub;
      return Reflect.get(target, prop, receiver);
    },
  });

  // Both names, for the same reason the script bundle provides both: a project
  // either imports Phaser or expects it as a global, and this has to work for
  // either without knowing which.
  const factory = new Function("__mosaicPhaser", "Phaser", code);
  factory(patched, patched);
  return captured;
}

/**
 * Compiles and starts the project's own game.
 *
 * `preferKey` is the scene the editor is showing; when the project has one by
 * that name it is the one started, so RUN corresponds to what is on screen
 * rather than to whatever the game happens to boot with.
 */
export async function runProjectGame(
  game: Phaser.Game,
  root: string,
  entry: string,
  preferKey: string | null,
): Promise<ProjectRunResult> {
  if (!isTrusted(root)) {
    return { ok: false, error: "This project has not been trusted to run its own code." };
  }

  const bundle = await platform.bundleEntry(root, entry);
  if (!bundle.code) return { ok: false, error: bundle.error ?? "the project did not compile" };

  let config: CapturedConfig | null;
  try {
    config = evaluateEntry(bundle.code);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (!config) return { ok: false, error: `${entry} did not construct a Phaser.Game.` };

  const classes = (Array.isArray(config.scene) ? config.scene : config.scene ? [config.scene] : [])
    .filter((c): c is new () => Phaser.Scene => typeof c === "function");
  if (!classes.length) return { ok: false, error: "The game config listed no scene classes." };

  stopProjectGame(game);

  // Registered under the key each scene declares for itself, so the project's
  // own `scene.start("MainMenu")` finds what it is asking for.
  const keys: string[] = [];
  for (const Ctor of classes) {
    let key: string;
    try {
      key = keyOf(Ctor);
    } catch {
      continue;
    }
    if (!key || game.scene.getScene(key)) continue;
    game.scene.add(key, Ctor, false);
    keys.push(key);
  }
  if (!keys.length) return { ok: false, error: "None of the project's scenes could be registered." };
  registered.set(game, keys);

  // The project's own boot order first: assets are loaded by a preloader the
  // target scene does not run itself, and starting the target directly gives a
  // scene with no textures.
  const started = keys[0];
  game.scene.start(started);

  const wanted = preferKey && keys.includes(preferKey) ? preferKey : null;
  return { ok: true, keys, started: wanted ?? started };
}

/**
 * Waits for the project's own boot chain to finish loading.
 *
 * A fixed delay was wrong: how long a preloader takes depends on the project's
 * assets and where they come from — the same game reached its menu in two
 * seconds locally and was still loading at eight from a CDN. Handing over on a
 * timer meant sometimes starting a scene whose textures had not arrived.
 */
export async function waitForProjectLoad(
  game: Phaser.Game,
  bootKey: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawLoading = false;

  // Two signals, because neither is sufficient alone.
  //
  // "Nothing is loading" is also true BEFORE the chain has started, and acting
  // on that first reading handed over while the boot scene had not yet run its
  // own `create()` — which then started the preloader again, on top.
  //
  // But waiting only for a load to begin and end is worse: a loader that
  // finishes between two polls is never observed busy, and the wait then sat
  // out its entire timeout while the game had been ready for seconds. So the
  // chain having MOVED PAST its boot scene counts too — a preloader that has
  // started the next scene is a preloader that finished.
  while (Date.now() < deadline) {
    const active = game.scene.scenes.filter((s) => s.scene.isActive());
    const busy = active.some((s) => s.load?.isLoading?.());
    if (busy) sawLoading = true;
    else if (sawLoading) return true;
    else if (active.length && !active.every((s) => s.scene.key === bootKey)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Hands over to the scene the editor is showing.
 *
 * Separate from the start above because a menu waits for input that will never
 * arrive in a preview, so the scene worth seeing is usually behind one.
 */
export function showProjectScene(game: Phaser.Game, key: string): boolean {
  if (!game.scene.getScene(key)) return false;
  for (const other of registered.get(game) ?? []) {
    if (other !== key) game.scene.stop(other);
  }
  game.scene.start(key);
  return true;
}

/** Removes everything a run registered, so the editor's own scenes are alone again. */
export function stopProjectGame(game: Phaser.Game): void {
  for (const key of registered.get(game) ?? []) {
    try {
      game.scene.stop(key);
      game.scene.remove(key);
    } catch {
      /* a scene that never booted cannot be stopped, and does not need to be */
    }
  }
  registered.delete(game);
}

/** A Phaser scene declares its key to `super()`, so an instance is the only way to read it. */
function keyOf(Ctor: new () => Phaser.Scene): string {
  const probe = new Ctor() as Phaser.Scene & {
    sys?: { settings?: { key?: string } };
    _key?: string;
  };
  const settings = (probe as unknown as { sys?: { settings?: { key?: string } } }).sys?.settings;
  return settings?.key ?? (probe as unknown as { _key?: string })._key ?? "";
}
