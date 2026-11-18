import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { recorded } from "./desktop";
import { Workspace } from "../../src/editor/project/workspace";
import { ProjectStore } from "../../src/editor/store/project";
import { shapeOf } from "../../electron/classShape";
import { planTakeover, rewriteClass } from "../../src/editor/project/wireClass";
import type { SceneData, SceneObject } from "../../src/shared/types";
import type { SourceSite } from "../../electron/contract";

/**
 * Opening a Phaser game Mosaic did not make.
 *
 * Two fixtures, one per answer the editor can give:
 *
 * - `phaser2` has the shape of every game in the phaser-examples collection.
 *   It is refused before anything is read into the editor, and nothing is
 *   written — not the starter scene Mosaic used to put over it.
 * - `phaser3-template` has the shape of Phaser's own Vite template: scenes in
 *   src/game/scenes, art in public/assets, the game constructed from a
 *   DOMContentLoaded listener. It opens with no scenes and writes nothing;
 *   laying out one class writes exactly that class's data and layout beside
 *   it, never the class; and the result reopens without changing a byte.
 */
export async function checkAdoption(fixtures: string): Promise<{ name: string; problems: string[] }[]> {
  return [
    { name: "phaser2 — refused, nothing written", problems: await refusesPhaser2(path.join(fixtures, "phaser2")) },
    { name: "phaser3-template — adopted beside its own classes", problems: await adoptsTemplate(path.join(fixtures, "phaser3-template")) },
    { name: "phaser3-js-root — every scene imported at once, in JS, at the root", problems: await importsAllAtRoot(path.join(fixtures, "phaser3-js-root")) },
    { name: "phaser3-js-root — with consent, every class wired to its layout", problems: await wiresClasses(path.join(fixtures, "phaser3-js-root")) },
    { name: "take-over — create()'s own lines become layout references", problems: takesOver() },
  ];
}

function reset(): void {
  recorded.writes.length = 0;
  recorded.removed.length = 0;
  recorded.passthrough = null;
}

async function refusesPhaser2(root: string): Promise<string[]> {
  reset();
  const problems: string[] = [];
  const workspace = new Workspace(new ProjectStore());
  try {
    await workspace.open({ root, name: "phaser2" });
    problems.push("opened a Phaser 2 game instead of refusing it");
  } catch (err) {
    const message = (err as Error).message;
    if (!/Phaser 2/.test(message)) problems.push(`refused, but without saying why: ${message}`);
  }
  if (workspace.isOpen) problems.push("the workspace is open after a refusal");
  for (const w of recorded.writes) problems.push(`wrote ${w.rel}`);
  workspace.close();
  return problems;
}

async function adoptsTemplate(fixture: string): Promise<string[]> {
  reset();
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };

  // ---- opening writes nothing, and reads the game where it keeps things --
  {
    const store = new ProjectStore();
    const workspace = new Workspace(store);
    if (!(await workspace.open({ root: fixture, name: "phaser3-template" }))) return ["could not open"];
    await workspace.scripts.load(fixture);
    const p = store.project;
    expect(p.scenes.length === 0, `opened with ${p.scenes.length} scene(s); an adopted game starts with none`);
    expect(p.prefabs.length === 0, `opened with starter prefabs: ${p.prefabs.map((x) => x.name).join(", ")}`);
    expect(p.groups.length === 0, `opened with starter groups: ${p.groups.join(", ")}`);
    expect(!!workspace.adoption, "not marked as an adopted game");
    expect(workspace.adoption?.major === 3, `read Phaser ${workspace.adoption?.major}, wanted 3`);
    expect(workspace.adoption?.entries[0] === "src/main.ts", `entry ${workspace.adoption?.entries[0]}, wanted src/main.ts`);
    expect(p.config.paths.assets === "public/assets", `assets read from ${p.config.paths.assets}`);
    expect(p.config.paths.publicDir === "public", `public dir ${p.config.paths.publicDir}`);
    expect(p.config.canvas.width === 1024 && p.config.canvas.height === 768, `canvas ${p.config.canvas.width}×${p.config.canvas.height}`);
    expect(p.config.physics === "arcade", `physics read as ${p.config.physics}`);
    expect(!p.config.pixelArt, "pixel-art rendering turned on for a game that never asked for it");
    const keys = p.assets.map((a) => a.key).sort().join(",");
    expect(keys === "bg,logo,platform,star", `assets keyed ${keys} — the game's own art and nothing else`);
    expect(p.config.placeholders === false, "placeholder shapes offered in a game Mosaic did not make");
    expect(p.config.language === "ts", `language ${p.config.language}`);
    const scenes = workspace.gameScenes.map((s) => s.name).join(",");
    expect(scenes === "Boot,Game,GameOver,MainMenu,Preloader", `scene classes ${scenes}`);
    for (const w of recorded.writes) problems.push(`opening wrote ${w.rel}`);
    workspace.close();
  }

  // ---- laying out one class writes its two files and nothing else ---------
  const scratch = mkdtempSync(path.join(os.tmpdir(), "mosaic-adopt-"));
  try {
    cpSync(fixture, scratch, { recursive: true });
    // Phaser's own template turns no physics on. A layout for it must not
    // reach for scene.physics, which such a game does not have.
    const mainTs = path.join(scratch, "src/game/main.ts");
    const withPhysics = readFileSync(mainTs, "utf8");
    const without = withPhysics.replace(/\n\s*physics: \{[\s\S]*?\n {4}\},/, "");
    if (without === withPhysics) return [...problems, "could not strip the physics block from the scratch copy"];
    writeFileSync(mainTs, without);
    reset();
    recorded.passthrough = scratch;
    const gameBefore = readFileSync(path.join(scratch, "src/game/scenes/Game.ts"), "utf8");

    const store = new ProjectStore();
    const workspace = new Workspace(store);
    await workspace.open({ root: scratch, name: "phaser3-template" });
    await workspace.scripts.load(scratch);
    const game = workspace.gameScenes.find((s) => s.name === "Game");
    if (!game) return [...problems, "no Game class to lay out"];
    const wiring = await workspace.layOut(game);

    const written = [...new Set(recorded.writes.map((w) => w.rel))].sort();
    const wanted = [
      "mosaic.config.json",
      "phaser.editor.json",
      "src/game/scenes/Game.layout.ts",
      "src/game/scenes/Game.scene.json",
    ];
    expect(written.join(",") === wanted.join(","), `laying out Game wrote ${written.join(", ")}`);
    expect(
      readFileSync(path.join(scratch, "src/game/scenes/Game.ts"), "utf8") === gameBefore,
      "the Game class was changed",
    );
    expect(
      wiring?.[0]?.importLine === `import { preloadGame, createGame } from "./Game.layout";`,
      `wiring import is ${wiring?.[0]?.importLine}`,
    );
    expect(store.project.config.paths.scenes === "src/game/scenes", `scenes dir ${store.project.config.paths.scenes}`);
    expect(store.project.config.paths.prefabs === "src/game/prefabs", `prefabs dir ${store.project.config.paths.prefabs}`);
    expect(!workspace.deferredWrite, "still deferring writes after the first layout");

    // Place the game's own art and save: the layout must load it by the URL
    // the game's server serves it at, not by its path in the repo.
    const star = store.project.assets.find((a) => a.key === "star");
    const layer = store.project.scenes[0]?.layers.find((l) => l.kind === "object");
    if (star && layer) {
      store.transact("place", () => {
        store.project.scenes[0].objects.push({
          id: "obj-check",
          name: "star",
          type: "sprite",
          layerId: layer.id,
          parentId: null,
          x: 100,
          y: 100,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          originX: 0.5,
          originY: 0.5,
          visible: true,
          texture: "star",
          data: {},
        });
      });
      await workspace.saveNow();
      const layout = readFileSync(path.join(scratch, "src/game/scenes/Game.layout.ts"), "utf8");
      expect(
        layout.includes(`scene.load.image("star", "assets/star.png");`),
        "the layout does not load star from assets/star.png",
      );
      expect(!layout.includes("public/"), "the layout loads something by its repo path under public/");
      expect(!layout.includes("scene.physics"), "the layout uses scene.physics in a game without physics");
      expect(layout.includes(`import Phaser from "phaser";`), "the layout does not import Phaser in a game that does");
    } else {
      problems.push("no star asset or object layer to place on");
    }
    workspace.close();

    // ---- and it reopens as a Mosaic project, unchanged -------------------
    reset();
    const again = new ProjectStore();
    const reopened = new Workspace(again);
    await reopened.open({ root: scratch, name: "phaser3-template" });
    await reopened.scripts.load(scratch);
    expect(!reopened.adoption, "reopened as an unadopted game");
    expect(again.project.scenes.map((s) => s.key).join(",") === "Game", "reopened without its Game scene");
    expect(again.project.groups.length === 0, `reopened with groups ${again.project.groups.join(", ")}`);
    expect(!again.project.assets.some((a) => a.generated), "reopened with placeholder shapes");
    const left = reopened.unlaidScenes.map((s) => s.name).join(",");
    expect(left === "Boot,GameOver,MainMenu,Preloader", `classes left to lay out: ${left}`);
    await reopened.saveNow();
    for (const w of recorded.writes) {
      const abs = path.join(scratch, w.rel);
      const onDisk = existsSync(abs) ? readFileSync(abs, w.encoding === "base64" ? "base64" : "utf8") : null;
      if (onDisk === null) problems.push(`reopening would create ${w.rel}`);
      else if (onDisk !== w.contents) problems.push(`reopening would rewrite ${w.rel}`);
    }
    for (const issue of reopened.issues) problems.push(`issue on reopen: ${issue}`);
    reopened.close();
  } finally {
    reset();
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/**
 * The shape of the games in Phaser's examples repo: JavaScript, every scene
 * beside main.js, art from a CDN, `MainGame` declared in Game.js. Importing
 * every scene at once has to give each class a layout in JavaScript, beside
 * it, with no `./` in any path and the game's own background.
 *
 * The check has no window to run the game in, so recording fails here — which
 * is the other half of what this proves: a game that cannot be run still gets
 * one layout per scene, empty, rather than nothing.
 */
async function importsAllAtRoot(fixture: string): Promise<string[]> {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const scratch = mkdtempSync(path.join(os.tmpdir(), "mosaic-adopt-js-"));
  try {
    cpSync(fixture, scratch, { recursive: true });
    reset();
    recorded.passthrough = scratch;
    const before = new Map(
      ["main.js", "Boot.js", "MainMenu.js", "Game.js"].map((f) => [f, readFileSync(path.join(scratch, f), "utf8")]),
    );

    const store = new ProjectStore();
    const workspace = new Workspace(store);
    await workspace.open({ root: scratch, name: "bank" });
    await workspace.scripts.load(scratch);
    expect(store.project.config.language === "js", `language ${store.project.config.language}`);
    expect(workspace.language === "js", `layouts would be written in ${workspace.language}`);
    expect(store.project.assets.length === 0, `assets: ${store.project.assets.map((a) => a.key).join(", ")}`);
    expect(recorded.writes.length === 0, "opening wrote something");

    const result = await workspace.importAll();
    expect(result?.empty === 3, `${result?.empty} empty layout(s), wanted 3 when the game cannot be run`);
    const written = [...new Set(recorded.writes.map((w) => w.rel))].sort();
    const wanted = [
      "Boot.layout.js",
      "Boot.scene.json",
      "MainGame.layout.js",
      "MainGame.scene.json",
      "MainMenu.layout.js",
      "MainMenu.scene.json",
      "mosaic.config.json",
      "phaser.editor.json",
    ];
    expect(written.join(",") === wanted.join(","), `importing wrote ${written.join(", ")}`);
    for (const [file, text] of before) {
      expect(readFileSync(path.join(scratch, file), "utf8") === text, `${file} was changed`);
    }
    const manifest = readFileSync(path.join(scratch, "phaser.editor.json"), "utf8");
    expect(!manifest.includes('"./'), "the manifest names files with a ./ prefix");
    expect(!manifest.includes("shape-"), "the manifest lists placeholder shapes");
    const layout = readFileSync(path.join(scratch, "MainGame.layout.js"), "utf8");
    expect(layout.includes('setBackgroundColor("#2e91f3")'), "MainGame's layout does not keep the game's background");
    expect(!layout.includes("scene.physics"), "the layout uses scene.physics in a game without physics");
    expect(!/: Phaser\.|interface /.test(layout), "the JavaScript layout has TypeScript in it");
    // Phaser comes from a script tag here and the modules run unbundled, so a
    // bare `from "phaser"` would stop the game the moment a layout is wired.
    expect(store.project.config.phaser === "global", `Phaser read as ${store.project.config.phaser ?? "module"}`);
    expect(!layout.includes(`from "phaser"`), "the layout imports phaser in a game that has it as a global");
    const mainGame = workspace.wiring?.find((w) => w.cls === "MainGame");
    expect(
      mainGame?.importLine === `import { preloadMainGame, createMainGame } from "./MainGame.layout.js";`,
      `MainGame's wiring import is ${mainGame?.importLine}`,
    );
    expect(mainGame?.src === "Game.js", `MainGame's class found in ${mainGame?.src}`);
    expect(workspace.wiring?.length === 3, `wiring for ${workspace.wiring?.length} scene(s)`);
    workspace.close();

    // Reopening reads it back as written.
    reset();
    const again = new Workspace(new ProjectStore());
    await again.open({ root: scratch, name: "bank" });
    await again.scripts.load(scratch);
    expect(again.unlaidScenes.length === 0, `left without a layout: ${again.unlaidScenes.map((s) => s.name).join(", ")}`);
    await again.saveNow();
    for (const w of recorded.writes) {
      const abs = path.join(scratch, w.rel);
      const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (onDisk !== w.contents) problems.push(`reopening would ${onDisk === null ? "create" : "rewrite"} ${w.rel}`);
    }
    for (const issue of again.issues) problems.push(`issue on reopen: ${issue}`);
    again.close();
  } finally {
    reset();
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/**
 * The import with the user's consent to edit code. The game cannot be run
 * here, so every layout is empty: each class gains its import and both calls,
 * still parses, and the entry file is untouched. Reopening wires nothing twice.
 */
async function wiresClasses(fixture: string): Promise<string[]> {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const scratch = mkdtempSync(path.join(os.tmpdir(), "mosaic-wire-"));
  try {
    cpSync(fixture, scratch, { recursive: true });
    reset();
    recorded.passthrough = scratch;
    const mainBefore = readFileSync(path.join(scratch, "main.js"), "utf8");
    const store = new ProjectStore();
    const workspace = new Workspace(store);
    await workspace.open({ root: scratch, name: "bank" });
    await workspace.scripts.load(scratch);
    await workspace.importAll({ wire: true });

    expect(readFileSync(path.join(scratch, "main.js"), "utf8") === mainBefore, "main.js was changed");
    const classes: [string, string][] = [["Boot.js", "Boot"], ["MainMenu.js", "MainMenu"], ["Game.js", "MainGame"]];
    for (const [file, cls] of classes) {
      const text = readFileSync(path.join(scratch, file), "utf8");
      expect(
        text.includes(`import { preload${cls}, create${cls} } from "./${cls}.layout.js";`),
        `${file} does not import its layout`,
      );
      expect(text.includes(`preload${cls}(this);`), `${file} does not call preload${cls}`);
      // Nothing was taken over, so no local is declared for it: a project
      // with noUnusedLocals would not build with one.
      expect(text.includes(`    create${cls}(this);`), `${file} does not call create${cls} as a statement`);
      expect(!text.includes("const layout"), `${file} declares a layout it never uses`);
      const shape = shapeOf(file, text, cls);
      expect(shape.ok, `${file} no longer parses: ${shape.reason}`);
      expect(text.indexOf(`preload${cls}(this)`) < text.indexOf(`create${cls}(this)`), `${file}: preload() was put after create()`);
    }
    const menu = readFileSync(path.join(scratch, "MainMenu.js"), "utf8");
    expect(
      menu.includes("    preload ()\n    {\n        preloadMainMenu(this);\n    }\n\n    create ()\n    {\n        createMainMenu(this);\n\n        this.add.image"),
      `MainMenu.js was not edited in its own style:\n${menu}`,
    );
    const wired = workspace.wiring ?? [];
    expect(wired.length === 3 && wired.every((w) => w.applied && w.wired), `wiring: ${wired.map((w) => `${w.cls}:${w.applied ? "applied" : w.failed}`).join(", ")}`);
    workspace.close();

    // Reopened, it is a Mosaic project whose classes already import their layouts.
    reset();
    const again = new Workspace(new ProjectStore());
    await again.open({ root: scratch, name: "bank" });
    await again.scripts.load(scratch);
    expect(again.unlaidScenes.length === 0, "a wired class reads as having no layout");
    await again.saveNow();
    for (const w of recorded.writes) {
      const abs = path.join(scratch, w.rel);
      const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (onDisk !== w.contents) problems.push(`reopening would ${onDisk === null ? "create" : "rewrite"} ${w.rel}`);
    }
    again.close();
  } finally {
    reset();
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/**
 * The take-over itself, on Bank Panic's MainMenu with a loop and a preload()
 * object added: objects made once, straight in create(), are swapped for the
 * layout's; the rest stay the code's.
 */
function takesOver(): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const source = `import Bandit from './Bandit.js';

export default class MainMenu extends Phaser.Scene
{
    preload ()
    {
        this.loading = this.add.image(512, 384, 'loading');
    }

    create ()
    {
        this.add.image(512, 384, 'title');

        let sign = this.add.image(512, -400, 'logo');

        this.tweens.add({ targets: sign, y: 180 });

        let cactus2 = this.add.image(880, 680, 'assets', 'cactus').setFlipX(true);

        for (let i = 0; i < 3; i++)
        {
            this.add.image(100 * i, 0, 'assets', 'gold');
        }

        this.title = this.add.text(10, 10, 'Bank Panic');
    }
}
`;
  // Where V8 points a call frame for `this.add.image(…)`: at the method name.
  const at = (needle: string): SourceSite => {
    const i = source.indexOf(needle);
    const name = source.indexOf("this.add.", i) + "this.add.".length;
    const lineStartsAt = source.lastIndexOf("\n", name - 1) + 1;
    return { src: "MainMenu.js", line: source.slice(0, name).split("\n").length, col: name - lineStartsAt };
  };
  const obj = (id: string, name: string, extra: Partial<SceneObject> = {}): SceneObject =>
    ({ id, name, type: "sprite", layerId: "l", parentId: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5, visible: true, data: {}, texture: "assets", ...extra }) as SceneObject;
  const scene = {
    key: "MainMenu",
    objects: [
      obj("loading", "Image", { texture: "loading" }),
      obj("title", "Image", { texture: "title" }),
      obj("logo", "Image", { texture: "logo" }),
      obj("cactus", "Image_cactus", { frame: "cactus" }),
      obj("g0", "Image_gold", { frame: "gold" }),
      obj("g1", "Image_gold2", { frame: "gold" }),
      obj("g2", "Image_gold3", { frame: "gold" }),
      obj("text", "Text", { type: "text", texture: undefined }),
    ],
  } as unknown as SceneData;
  const sites: Record<string, SourceSite[]> = {
    loading: [at("this.loading = this.add")],
    title: [at("this.add.image(512, 384, 'title')")],
    logo: [at("let sign")],
    cactus: [at("let cactus2")],
    g0: [at("this.add.image(100 * i")],
    g1: [at("this.add.image(100 * i")],
    g2: [at("this.add.image(100 * i")],
    text: [at("this.title = ")],
  };

  const shape = shapeOf("MainMenu.js", source, "MainMenu");
  expect(shape.ok, `did not parse: ${shape.reason}`);
  const plan = planTakeover(shape, scene, sites);
  const taken = [...plan.taken.keys()].sort().join(",");
  expect(taken === "cactus,logo,title", `took over ${taken}, wanted cactus,logo,title`);
  const why = Object.fromEntries(plan.left.map((l) => [l.id, l.why]));
  expect(/preload/.test(why.loading ?? ""), `loading left because: ${why.loading}`);
  expect(/loop/.test(why.g0 ?? ""), `gold left because: ${why.g0}`);
  expect(/text/.test(why.text ?? ""), `text left because: ${why.text}`);

  const fields: Record<string, string> = { title: "title", logo: "sign", cactus: "cactus2" };
  const result = rewriteClass(shape, {
    cls: "MainMenu",
    importLine: `import { preloadMainMenu, createMainMenu } from "./MainMenu.layout.js";`,
    preloadCall: "preloadMainMenu(this)",
    createCall: "createMainMenu(this)",
    uses: [...plan.taken].map(([id, call]) => ({ call, field: fields[id] })),
  });
  if ("reason" in result) return [...problems, `not rewritten: ${result.reason}`];
  const out = result.source;
  const want = `import Bandit from './Bandit.js';
import { preloadMainMenu, createMainMenu } from "./MainMenu.layout.js";

export default class MainMenu extends Phaser.Scene
{
    preload ()
    {
        preloadMainMenu(this);
        this.loading = this.add.image(512, 384, 'loading');
    }

    create ()
    {
        const layout = createMainMenu(this);

        let sign = layout.sign;

        this.tweens.add({ targets: sign, y: 180 });

        let cactus2 = layout.cactus2.setFlipX(true);

        for (let i = 0; i < 3; i++)
        {
            this.add.image(100 * i, 0, 'assets', 'gold');
        }

        this.title = this.add.text(10, 10, 'Bank Panic');
    }
}
`;
  expect(out === want, `rewritten as:\n${out}`);
  expect(shapeOf("MainMenu.js", out, "MainMenu").ok, "the rewritten class does not parse");
  return problems;
}
