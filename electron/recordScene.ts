import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { BrowserWindow, net, session } from "electron";
import { RECORD_SCHEME } from "./assets";
import { projectPaths } from "./projectFiles";
import { rolldown } from "rolldown";
import type { SceneRecording, SourceSite } from "./contract";
import { SourceMapReader, type RawSourceMap } from "./sourceMap";

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

async function bundle(root: string, entry: string): Promise<{ code: string; map: RawSourceMap | null }> {
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
    // The map is how a recorded object is traced back to the line that made
    // it. `dir` is never written to; it makes the map's paths project-relative.
    sourcemap: true,
    dir: root,
  });
  await build.close();
  const map = output[0].map as unknown as RawSourceMap | null;
  return { code: output[0].code, map: map ? { sources: map.sources, mappings: map.mappings } : null };
}

/**
 * Where each recorded object was made, in the project's own files.
 *
 * The harness keeps the bundle positions of the stack that added an object to
 * its scene; the bundle's source map turns those into file and line. Frames in
 * anything that is not the project's — Phaser, node_modules — are dropped, so
 * the first site is the project line closest to the object.
 */
function attachSites(scenes: Record<string, unknown>, map: RawSourceMap | null, root: string): void {
  const reader = map ? new SourceMapReader(map) : null;
  for (const snap of Object.values(scenes)) {
    const objects = (snap as { objects?: { at?: [number, number][]; sites?: SourceSite[] }[] }).objects;
    if (!objects) continue;
    for (const o of objects) {
      const at = o.at;
      delete o.at;
      if (!reader || !at) continue;
      const sites: SourceSite[] = [];
      for (const [line, column] of at) {
        const hit = reader.lookup(line, Math.max(0, column - 1));
        if (!hit) continue;
        const abs = path.resolve(root, hit.source);
        if (!abs.startsWith(root + path.sep)) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (rel.split("/").includes("node_modules")) continue;
        sites.push({ src: rel, line: hit.line, col: hit.column });
      }
      if (sites.length) o.sites = sites;
    }
  }
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
// Where each object came from: the stack that put it on a scene's display
// list, as positions in the bundle. Kept raw here; the main process reads them
// back through the source map.
Error.stackTraceLimit = 40;
(function () {
  const DL = Phaser.GameObjects.DisplayList && Phaser.GameObjects.DisplayList.prototype;
  if (!DL || typeof DL.addChildCallback !== "function") return;
  const original = DL.addChildCallback;
  DL.addChildCallback = function (gameObject) {
    if (gameObject && !gameObject.__mosaicAt) {
      const at = [];
      for (const line of String(new Error().stack).split("\n")) {
        const m = /__mosaic_record__\/bundle\.js:(\d+):(\d+)/.exec(line);
        if (m) at.push([+m[1], +m[2]]);
        if (at.length >= 8) break;
      }
      gameObject.__mosaicAt = at;
    }
    return original.call(this, gameObject);
  };
})();
const RealGame = Phaser.Game;
let captured = null;
Phaser.Game = function (config) { captured = config; return { config, scene: { add() {}, start() {} } }; };
// Phaser's own templates construct the game from a DOMContentLoaded listener,
// which has not fired when this is first called. So boot runs once the page
// has loaded if nothing was constructed yet, and only then gives up.
window.__boot = function () {
  if (captured) return start();
  const later = () => setTimeout(() => {
    if (captured) start();
    else { Phaser.Game = RealGame; window.__done = { error: "No Phaser.Game was constructed by this file." }; }
  }, 0);
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
};
function start() {
  Phaser.Game = RealGame;
  const cfg = captured;
  const classes = Array.isArray(cfg.scene) ? cfg.scene : cfg.scene ? [cfg.scene] : [];
  if (!classes.length) { window.__done = { error: "The game config lists no scenes." }; return; }

  const loads = [];
  const snaps = {};
  const r = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
  const rgb = (c) => "#" + [c.red, c.green, c.blue].map((v) => v.toString(16).padStart(2, "0")).join("");

  // The class name is what a layout is named after. A bundler that renames a
  // clashing class appends $1, $2; that suffix is the bundler's, not the
  // author's.
  const wrap = (C) => { const name = String(C.name || "").replace(/\$\d+$/, ""); return class extends C {
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
      try { snaps[this.scene.key] = snapshot(this, cfg, createError, loads); snaps[this.scene.key].className = name || null; } catch (e) {
        snaps[this.scene.key] = { error: String(e) };
      }
    }
  }; };

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
          at: o.__mosaicAt && o.__mosaicAt.length ? o.__mosaicAt : undefined,
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
  //
  // "Loads the assets" is waited for rather than timed: art from a CDN takes
  // as long as it takes, and a fixed pause cut it off and recorded every
  // sprite as __MISSING. The wait ends once no loader has been busy for a
  // moment, or at a ceiling well inside the main process's deadline.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const loading = () => game.scene.scenes.some((s) => s.load && s.load.isLoading && s.load.isLoading());
  const settle = async (min, max) => {
    const start = Date.now();
    let quiet = 0;
    await sleep(min);
    while (Date.now() - start < max) {
      quiet = loading() ? 0 : quiet + 1;
      if (quiet >= 3) return;
      await sleep(100);
    }
  };
  (async () => {
    await settle(1500, 12000);
    const keys = game.scene.scenes.map((s) => s.scene.key);
    for (const k of keys) { try { game.scene.stop(k); } catch (e) {} }
    for (const k of keys) {
      try { game.scene.start(k); } catch (e) {}
      // A scene's own preload runs first; create() follows when it is done.
      await settle(700, 6000);
      try { game.scene.stop(k); } catch (e) {}
    }
    let textures = [];
    try { textures = captureTextures(game); } catch (e) {}
    for (const k of Object.keys(snaps)) if (snaps[k]) snaps[k].textures = textures;
    window.__done = { scenes: snaps };
  })();
};
`;

export async function recordScene(
  root: string,
  entry: string,
  timeoutMs = 90_000,
): Promise<SceneRecording> {
  let dir: string | null = null;
  let win: BrowserWindow | null = null;
  let partition = "";
  let ses: Electron.Session | null = null;
  try {
    const { code, map } = await bundle(root, entry);
    // `phaser/dist/phaser.js` is not a path the package's `exports` map allows,
    // but the bare specifier resolves to exactly that file under `require` —
    // the UMD build, which is the one that defines a `Phaser` global for the
    // harness and the project's bundle to share.
    const phaser = await fs.readFile(require_.resolve("phaser"), "utf8");

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mosaic-import-"));
    await fs.writeFile(path.join(dir, "phaser.js"), phaser);
    await fs.writeFile(path.join(dir, "bundle.js"), code);
    await fs.writeFile(path.join(dir, "harness.js"), HARNESS);
    // The page's base is the game's own web root, so `assets/bg.png` means
    // what it means under the game's dev server. The harness sits under a
    // prefix nothing in a game would use.
    await fs.writeFile(
      path.join(dir, "record.html"),
      `<!doctype html><meta charset="utf-8">
<base href="${RECORD_SCHEME}://game/">
<script src="${HARNESS_PREFIX}phaser.js"></script>
<script src="${HARNESS_PREFIX}harness.js"></script>
<script src="${HARNESS_PREFIX}bundle.js"></script>
<script>window.__boot();</script>`,
    );

    // A session of its own, so the scheme that serves the project exists only
    // for this window and only for as long as it is open.
    partition = `mosaic-record-${process.pid}-${Date.now()}`;
    ses = session.fromPartition(partition);
    const served = path.resolve(root, await webRoot(root));
    const harness = dir;
    ses.protocol.handle(RECORD_SCHEME, (request) => serveRecording(request, served, harness));
    // A game that loads its art from a CDN only works on the origins that CDN
    // allows — Phaser's own examples load from one that answers phaser.io and
    // nothing else, localhost included. The recording is not one of those
    // origins, so every texture came back missing. This session has no
    // cookies or credentials of any kind, so letting the page read what it
    // fetched exposes nothing; it only lets the game load what it loads.
    ses.webRequest.onHeadersReceived({ urls: ["https://*/*", "http://*/*"] }, (details, callback) => {
      const headers: Record<string, string[]> = {};
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (!/^access-control-allow-origin$/i.test(name)) headers[name] = value;
      }
      headers["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders: headers });
    });

    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, partition },
    });

    await win.loadURL(`${RECORD_SCHEME}://game/${HARNESS_PREFIX}record.html`);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) return { ok: false, error: `Timed out after ${timeoutMs / 1000}s` };
      const done = await win.webContents
        .executeJavaScript("window.__done && JSON.stringify(window.__done)")
        .catch(() => null);
      if (done) {
        const parsed = JSON.parse(done as string) as { error?: string; scenes?: Record<string, unknown> };
        if (parsed.error) return { ok: false, error: parsed.error };
        if (parsed.scenes) attachSites(parsed.scenes, map, path.resolve(root));
        return { ok: true, scenes: parsed.scenes as SceneRecording["scenes"] };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    win?.destroy();
    if (ses) ses.protocol.unhandle(RECORD_SCHEME);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Where the harness's own files are served, inside the game's origin. */
const HARNESS_PREFIX = "__mosaic_record__/";

/**
 * The folder the game's dev server serves as `/`: the project's own setting,
 * else Vite's `public/` when there is one, else the project root.
 *
 * A game loads `assets/bg.png` relative to the page. Recording from a temp
 * folder resolved that against the temp folder, so every texture of a game
 * that loads by relative path came up missing — Phaser's own template among
 * them.
 */
async function webRoot(root: string): Promise<string> {
  const paths = await projectPaths(root);
  if (paths.publicDir !== undefined) return paths.publicDir;
  try {
    if ((await fs.stat(path.join(root, "public"))).isDirectory()) return "public";
  } catch {
    // No public folder: the root is what is served.
  }
  return "";
}

/**
 * Serves the recording: the harness under its prefix, and everything else
 * from the game's web root. Nothing outside those two folders is reachable,
 * because the game's code runs in this window and it is a game, not a file
 * browser.
 */
function serveRecording(request: Request, served: string, harness: string): Response | Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (url.hostname !== "game") return new Response("not found", { status: 404 });
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let base = served;
  if (rel.startsWith(HARNESS_PREFIX)) {
    rel = rel.slice(HARNESS_PREFIX.length);
    base = harness;
  }
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return new Response("forbidden", { status: 403 });
  return net.fetch(pathToFileURL(abs).toString());
}
