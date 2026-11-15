import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { BrowserWindow } from "electron";
import { rolldown } from "rolldown";
import type { SceneRecording } from "./contract";

/**
 * Records what a hand-written Phaser scene actually builds.
 *
 * Mosaic's scene model is declarative; a `create()` method is not. There is no
 * sound way to READ imperative code into an object list — loops, helpers and
 * data-driven spawns defeat any pattern match — so this does the one thing that
 * is sound: it RUNS the project's own code and looks at the result. Whatever
 * `create()` put on the display list is what gets imported, and whatever it did
 * not is simply absent. That boundary is sharp enough to explain to somebody.
 *
 * Three things make it safe enough to do at all:
 *
 * - **Its own window.** The project's code never touches the editor's renderer.
 *   A scene that throws, hangs or exhausts memory takes down a hidden window
 *   that is destroyed either way, not the app.
 * - **A deadline.** `create()` is not required to terminate, so the window is
 *   killed on a timer regardless of what the page is doing.
 * - **Consent upstream.** The renderer will not call this without the same
 *   per-folder trust RUN already asks for. Running somebody's game is
 *   not something to do because they opened a folder.
 *
 * Nothing is written to the project. The bundle and the harness page live in a
 * temp directory that is removed on the way out.
 */

const require_ = createRequire(import.meta.url);

/** Files that construct a game, which is what the recorder needs as an entry. */
export async function findGameEntries(root: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"]);

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? path.posix.join(dir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith(".")) await walk(rel, depth + 1);
        continue;
      }
      if (!/\.(m?js|ts)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const stat = await fs.stat(path.join(root, rel)).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      const text = await fs.readFile(path.join(root, rel), "utf8").catch(() => "");
      // `new Phaser.Game(...)` is the one unambiguous marker of an entry point.
      if (/new\s+Phaser\s*\.\s*Game\s*\(/.test(text)) out.push(rel);
    }
  };

  await walk("", 0);
  // Conventional names first, then shallowest, then alphabetical. A project
  // routinely has more than one file that constructs a game — a variant entry,
  // a tutorial step — and the caller offers the first as the default, so the
  // order is the difference between running what the user meant and running
  // whatever sorted earliest.
  const rank = (rel: string): number => {
    const base = rel.split("/").pop() ?? rel;
    const stem = base.replace(/\.\w+$/, "").toLowerCase();
    if (stem === "main") return 0;
    if (stem === "index") return 1;
    if (stem === "game") return 2;
    return 3;
  };
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b),
  );
}

async function bundle(root: string, entry: string): Promise<string> {
  const build = await rolldown({
    input: { bundle: path.resolve(root, entry) },
    cwd: root,
    platform: "browser",
    // Projects reach Phaser either way: `import Phaser from "phaser"` or the
    // plain global the examples use. Externalising onto the global covers both,
    // and keeps a second copy of Phaser out of the bundle — which would break
    // every `instanceof` the recorder relies on to read the display list.
    external: ["phaser"],
    transform: { decorator: { legacy: true } },
    onLog() {},
  });
  const { output } = await build.generate({
    format: "iife",
    name: "MosaicImport",
    globals: { phaser: "Phaser" },
    sourcemap: false,
  });
  await build.close();
  return output[0].code;
}

/**
 * The harness. Runs inside the hidden window, beside the project's own bundle.
 *
 * It stubs `Phaser.Game` before the bundle evaluates, because an entry point
 * constructs the game at module scope — so the constructor is where the real
 * config is, scene list and background colour included. Reading that statically
 * would mean parsing an object literal; catching it is exact.
 */
const HARNESS = String.raw`
window.__done = null;
const RealGame = Phaser.Game;
let captured = null;
Phaser.Game = function (config) { captured = config; return { config, scene: { add() {}, start() {} } }; };
window.__boot = function () {
  Phaser.Game = RealGame;
  if (!captured) { window.__done = { error: "No Phaser.Game was constructed by this file." }; return; }
  const cfg = captured;
  const classes = Array.isArray(cfg.scene) ? cfg.scene : cfg.scene ? [cfg.scene] : [];
  if (!classes.length) { window.__done = { error: "The game config lists no scenes." }; return; }

  const loads = [];
  const snaps = {};
  const r = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
  const rgb = (c) => "#" + [c.red, c.green, c.blue].map((v) => v.toString(16).padStart(2, "0")).join("");

  const wrap = (C) => class extends C {
    preload() {
      const L = this.load;
      for (const m of ["image","spritesheet","atlas","audio","glsl","json","bitmapFont","tilemapTiledJSON"]) {
        if (typeof L[m] !== "function") continue;
        const orig = L[m].bind(L);
        L[m] = (...a) => {
          try { loads.push({ method: m, args: JSON.parse(JSON.stringify(a)), path: L.path, baseURL: L.baseURL }); } catch (e) {}
          return orig(...a);
        };
      }
      if (super.preload) super.preload();
    }
    create(...a) {
      let createError = null;
      // A scene that throws halfway still built everything up to the throw,
      // and that partial result is worth more than nothing — so it is kept and
      // the failure reported alongside it.
      try { if (super.create) super.create(...a); } catch (e) { createError = String((e && e.message) || e); }
      try { snaps[this.scene.key] = snapshot(this, cfg, createError, loads); } catch (e) {
        snaps[this.scene.key] = { error: String(e) };
      }
    }
  };

  function snapshot(scene, cfg, createError, loads) {
    const objects = [];
    const walk = (list, parent) => {
      for (const o of list) {
        const rec = {
          kind: o.constructor && o.constructor.name, name: o.name || null, parent,
          x: r(o.x), y: r(o.y), depth: o.depth,
          rotationDeg: r(Phaser.Math.RadToDeg(o.rotation || 0)),
          scaleX: r(o.scaleX), scaleY: r(o.scaleY), originX: r(o.originX), originY: r(o.originY),
          visible: o.visible,
          texture: o.texture ? o.texture.key : undefined,
          frame: o.frame && o.frame.name !== "__BASE" ? String(o.frame.name) : undefined,
          text: o.text !== undefined ? String(o.text) : undefined,
          anim: o.anims && o.anims.currentAnim ? o.anims.currentAnim.key : undefined,
        };
        if (o.body) rec.body = {
          w: r(o.body.width), h: r(o.body.height), immovable: !!o.body.immovable,
          allowGravity: !!o.body.allowGravity, collideWorldBounds: !!o.body.collideWorldBounds,
          bounceX: o.body.bounce ? r(o.body.bounce.x) : 0, bounceY: o.body.bounce ? r(o.body.bounce.y) : 0,
        };
        objects.push(rec);
        if (o.list && Array.isArray(o.list)) walk(o.list, o.name || rec.kind);
      }
    };
    walk(scene.children.list, null);
    const cam = scene.cameras && scene.cameras.main;
    const anims = scene.anims.anims.keys().map((k) => {
      const a = scene.anims.get(k);
      return { key: k, frameRate: a.frameRate, repeat: a.repeat, yoyo: !!a.yoyo,
               frames: a.frames.map((f) => ({ textureKey: f.textureKey, frame: String(f.textureFrame) })) };
    });
    return {
      sceneKey: scene.scene.key, createError,
      settings: {
        backgroundColor: cam && cam.backgroundColor ? rgb(cam.backgroundColor) : null,
        backgroundColorAlpha: cam && cam.backgroundColor ? cam.backgroundColor.alpha : null,
        gameBackgroundColor: cfg.backgroundColor != null ? String(cfg.backgroundColor) : null,
        canvas: { w: cfg.width || 0, h: cfg.height || 0 },
        worldBounds: scene.physics && scene.physics.world
          ? { w: scene.physics.world.bounds.width, h: scene.physics.world.bounds.height } : null,
        gravityY: scene.physics && scene.physics.world ? scene.physics.world.gravity.y : null,
      },
      anims, loads, objects,
    };
  }

  const game = new Phaser.Game({
    ...cfg, type: Phaser.HEADLESS, banner: false, audio: { noAudio: true },
    parent: undefined, scene: classes.map(wrap),
  });

  // Whatever the loader resolved is the truth about an asset: it survives a
  // CDN base URL, a setPath prefix and a relative path equally, because by this
  // point Phaser has already fetched the bytes. Reading them back beats trying
  // to reconstruct a filesystem path the project may not even have.
  function captureTextures(game) {
    const out = [];
    for (const key of game.textures.getTextureKeys()) {
      if (key === "__DEFAULT" || key === "__MISSING" || key === "__WHITE") continue;
      let tex;
      try { tex = game.textures.get(key); } catch (e) { continue; }
      // Text mints a canvas texture per object under a uuid key. It is not an
      // asset and importing it would invent one that does not exist.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key)) continue;
      let src;
      try { src = tex.getSourceImage(); } catch (e) { continue; }
      if (!src || !src.width) continue;
      let dataUrl = "";
      try {
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        c.getContext("2d").drawImage(src, 0, 0);
        dataUrl = c.toDataURL("image/png");
      } catch (e) { continue; }

      // An atlas is only useful with its frame boxes: every sprite in the scene
      // refers to one by name.
      const frames = [];
      try {
        for (const name of tex.getFrameNames()) {
          const f = tex.frames[name];
          if (!f) continue;
          frames.push({ name, x: f.cutX, y: f.cutY, w: f.width, h: f.height,
                        pivotX: f.pivotX ?? 0.5, pivotY: f.pivotY ?? 0.5 });
        }
      } catch (e) {}
      out.push({ key, width: src.width, height: src.height, dataUrl, frames });
    }
    return out;
  }

  // The natural chain loads the assets. After that every scene is visited by
  // hand, because a menu waits for a click that is never coming and the scene
  // worth importing is usually behind it.
  setTimeout(async () => {
    const keys = game.scene.scenes.map((s) => s.scene.key);
    for (const k of keys) { try { game.scene.stop(k); } catch (e) {} }
    for (const k of keys) {
      try { game.scene.start(k); } catch (e) {}
      await new Promise((res) => setTimeout(res, 700));
      try { game.scene.stop(k); } catch (e) {}
    }
    let textures = [];
    try { textures = captureTextures(game); } catch (e) {}
    for (const k of Object.keys(snaps)) if (snaps[k]) snaps[k].textures = textures;
    window.__done = { scenes: snaps };
  }, 3500);
};
`;

export async function recordScene(
  root: string,
  entry: string,
  timeoutMs = 30_000,
): Promise<SceneRecording> {
  let dir: string | null = null;
  let win: BrowserWindow | null = null;
  try {
    const code = await bundle(root, entry);
    // `phaser/dist/phaser.js` is not a path the package's `exports` map allows,
    // but the bare specifier resolves to exactly that file under `require` —
    // the UMD build, which is the one that defines a `Phaser` global for the
    // harness and the project's bundle to share.
    const phaser = await fs.readFile(require_.resolve("phaser"), "utf8");

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mosaic-import-"));
    await fs.writeFile(path.join(dir, "phaser.js"), phaser);
    await fs.writeFile(path.join(dir, "bundle.js"), code);
    await fs.writeFile(path.join(dir, "harness.js"), HARNESS);
    await fs.writeFile(
      path.join(dir, "record.html"),
      `<!doctype html><meta charset="utf-8">
<script src="phaser.js"></script>
<script src="harness.js"></script>
<script src="bundle.js"></script>
<script>window.__boot();</script>`,
    );

    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
    });

    await win.loadFile(path.join(dir, "record.html"));

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) return { ok: false, error: `Timed out after ${timeoutMs / 1000}s` };
      const done = await win.webContents
        .executeJavaScript("window.__done && JSON.stringify(window.__done)")
        .catch(() => null);
      if (done) {
        const parsed = JSON.parse(done as string) as { error?: string; scenes?: Record<string, unknown> };
        if (parsed.error) return { ok: false, error: parsed.error };
        return { ok: true, scenes: parsed.scenes as SceneRecording["scenes"] };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    win?.destroy();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
