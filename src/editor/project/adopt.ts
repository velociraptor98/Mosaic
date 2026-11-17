import type { ScriptClass, ScriptIndex } from "../scripts/parse";
import type { ExistingProject } from "../platform/types";
import type { Language } from "../export/generate";
import { className, sceneLayoutPath } from "../export/generate";
import type { ProjectData } from "../../shared/types";

/**
 * Opening a Phaser game Mosaic did not make.
 *
 * The rule from the rest of the editor holds here unchanged: `*.layout.ts` is
 * generated, everything else is yours. Adopting a game therefore writes
 * nothing of the game's — it adds, per scene, the scene's data and its layout
 * beside the class that already exists. The class itself is edited only when
 * the user agreed to it (see wireClass.ts); otherwise this says which lines
 * to add.
 */

/**
 * Why a folder cannot be opened, or null when it can.
 *
 * Phaser 2 is the one hard stop: it has states, not scenes, and nothing Mosaic
 * writes would run in it. Saying so on the launcher beats opening a starter
 * scene over it, which is what used to happen — and the first save then put
 * Phaser 3 files into a Phaser 2 game.
 */
export function refusal(existing: ExistingProject | null | undefined): string | null {
  if (!existing || existing.major === null || existing.major >= 3) return null;
  const where = existing.phaser
    ? `phaser ${existing.phaser} in ${existing.phaserFrom}`
    : "its code uses game states and a positional Phaser.Game constructor";
  return `This is a Phaser ${existing.major} game (${where}). Mosaic lays out Phaser 3 and 4 scenes, so it can't open this folder.`;
}

/** A class in the game that is a Phaser scene. */
export interface GameScene {
  /** Class name; also the Mosaic scene key a layout for it would use. */
  name: string;
  /** Project-relative file the class is declared in. */
  src: string;
  /** 1-based line of the declaration. */
  line: number;
  /** The key the class registers itself under, when it says so literally. */
  key: string | null;
}

/**
 * Every class whose base chain reaches `Phaser.Scene`, however it was named:
 * `extends Phaser.Scene`, `extends Scene` after `import { Scene }`, or
 * `extends BaseLevel` where BaseLevel is one of those.
 */
export function sceneClasses(index: ScriptIndex, sources: Map<string, string>): GameScene[] {
  const byName = new Map<string, ScriptClass>();
  for (const cls of index.classes) if (!byName.has(cls.name)) byName.set(cls.name, cls);

  const isScene = (cls: ScriptClass): boolean => {
    const seen = new Set<string>();
    let node: ScriptClass | undefined = cls;
    while (node && !seen.has(node.name)) {
      seen.add(node.name);
      const base = node.base;
      if (!base) return false;
      if (base === "Phaser.Scene" || base === "Scene") return true;
      node = byName.get(base.split(".").pop()!);
    }
    return false;
  };

  return index.classes
    .filter((c) => !/\.layout\.(ts|js)$/.test(c.src) && isScene(c))
    .map((c) => ({ name: c.name, src: c.src, line: c.line, key: registeredKey(sources.get(c.src), c.name) }))
    .sort((a, b) => a.src.localeCompare(b.src) || a.name.localeCompare(b.name));
}

/** `super("Game")` or `super({ key: "Game" })` inside the class's constructor. */
function registeredKey(text: string | undefined, cls: string): string | null {
  if (!text) return null;
  const start = text.search(new RegExp(`class\\s+${cls}\\b`));
  if (start < 0) return null;
  const body = text.slice(start, start + 4000);
  const m =
    /super\s*\(\s*["'`]([^"'`]+)["'`]/.exec(body) ??
    /super\s*\(\s*\{[^}]*\bkey\s*:\s*["'`]([^"'`]+)["'`]/.exec(body);
  return m ? m[1] : null;
}

/**
 * Where an adopted game's scene data and layouts go: the folder its scene
 * classes are already in, so each layout sits beside the class that imports
 * it. Prefabs go in a sibling `prefabs` folder. When the classes are spread
 * out, the folder holding most of them wins.
 */
export function adoptedDirs(scenes: GameScene[]): { scenes: string; prefabs: string } | null {
  if (!scenes.length) return null;
  const counts = new Map<string, number>();
  for (const s of scenes) {
    const dir = s.src.includes("/") ? s.src.slice(0, s.src.lastIndexOf("/")) : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const [dir] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  return { scenes: dir, prefabs: parent ? `${parent}/prefabs` : "prefabs" };
}

/** The scene classes that have no layout yet. */
export function unlaidScenes(project: ProjectData, scenes: GameScene[]): GameScene[] {
  const keys = new Set(project.scenes.map((s) => className(s.key)));
  return scenes.filter((s) => !keys.has(s.name));
}

/** What a class needs to pick up its layout: an import and two calls. */
export interface Wiring {
  cls: string;
  /** The class's file, to open in the user's editor. */
  src: string;
  line: number;
  layout: string;
  importLine: string;
  preloadLine: string;
  createLine: string;
  /** Whether the class already imports its layout. */
  wired: boolean;
  /**
   * Objects the layout builds that the class's own create() also builds —
   * set when the layout was imported from what create() made.
   */
  duplicates?: string[];
  /** Set when Mosaic edited the class itself, with the user's say-so. */
  applied?: { taken: string[]; left: { name: string; why: string }[] };
  /** Why Mosaic could not edit the class when it was allowed to. */
  failed?: string;
}

export function wiringFor(
  project: ProjectData,
  scene: GameScene,
  lang: Language,
  source: string | undefined,
): Wiring {
  const layout = sceneLayoutPath(scene.name, lang, project.config.paths);
  const classDir = dirOf(scene.src);
  const layoutDir = dirOf(layout);
  const stem = layout.split("/").pop()!.replace(/\.(ts|js)$/, lang === "js" ? ".js" : "");
  // Beside the class is the normal case; a class elsewhere imports across.
  const spec =
    classDir === layoutDir
      ? `./${stem}`
      : `${relativeDir(classDir, layoutDir)}/${stem}`;
  return {
    cls: scene.name,
    src: scene.src,
    line: scene.line,
    layout,
    importLine: `import { preload${scene.name}, create${scene.name} } from "${spec}";`,
    preloadLine: `preload${scene.name}(this);`,
    createLine: `const layout = create${scene.name}(this);`,
    wired: !!source && source.includes(`${scene.name}.layout`),
  };
}

/** The folder a project-relative path is in; "" for the root. */
function dirOf(rel: string): string {
  return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
}

function relativeDir(from: string, to: string): string {
  const a = from ? from.split("/") : [];
  const b = to ? to.split("/") : [];
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  const spec = [...a.map(() => ".."), ...b].join("/");
  return spec ? (spec.startsWith(".") ? spec : `./${spec}`) : ".";
}
