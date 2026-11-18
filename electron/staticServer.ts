import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { session } from "electron";
import type { DevServerResult } from "./contract";
import { findGameEntries, inspectExisting } from "./existingProject";

/**
 * RUN for a game that has no dev server, because it never needed one.
 *
 * Plenty of Phaser games are a folder of scripts and nothing else: Phaser's own
 * examples have no package.json, no index.html and no build step; the examples
 * site loads Phaser with a script tag and starts `main.js` as a module. That is
 * a complete, correct way to write a Phaser game, and "add a package.json"
 * would be Mosaic asking the developer to change it.
 *
 * So this does what that site does, and nothing more: serves the folder as it
 * is, and when the folder has no page of its own, a page that loads Phaser and
 * the file that starts the game. The folder is never written to. Like a dev
 * server, it reloads the page when a file changes, so saving in the editor
 * still reaches the game.
 */

interface Serving {
  server: http.Server;
  watcher: FSWatcher | null;
  /** Pages waiting to be told to reload. */
  clients: Set<http.ServerResponse>;
  origin: string;
  ready: Promise<DevServerResult>;
}

const serving = new Map<string, Serving>();

/** Where Mosaic's own files sit, under a prefix nothing in a game would use. */
const PREFIX = "/__mosaic__/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".xml": "application/xml",
  ".fnt": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".tmj": "application/json; charset=utf-8",
  ".tmx": "application/xml",
  ".csv": "text/csv; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export async function serveFolder(root: string): Promise<DevServerResult> {
  const existing = serving.get(root);
  if (existing) return existing.ready;

  const plan = await planPage(root);
  if (!plan.ok) return { ok: false, code: "no-package", error: plan.error, log: "" };

  const clients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    void handle(root, plan, clients, req, res).catch((err: Error) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err.message);
    });
  });

  const entry: Serving = { server, watcher: null, clients, origin: "", ready: null as never };
  entry.ready = new Promise<DevServerResult>((resolve) => {
    server.once("error", (err) => {
      serving.delete(root);
      resolve({ ok: false, code: "spawn", error: err.message, log: "" });
    });
    // Loopback only, on whatever port is free: this is the editor's preview,
    // not something to reach from the network.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      entry.origin = `http://127.0.0.1:${port}`;
      entry.watcher = watchForReload(root, clients);
      allowCrossOriginArt();
      resolve({
        ok: true,
        url: `${entry.origin}/`,
        log: plan.log,
      });
    });
  });
  serving.set(root, entry);
  return entry.ready;
}

export function stopServing(root: string): void {
  const entry = serving.get(root);
  if (!entry) return;
  serving.delete(root);
  close(entry);
}

export function stopAllServing(): void {
  for (const entry of serving.values()) close(entry);
  serving.clear();
}

function close(entry: Serving): void {
  entry.watcher?.close();
  for (const res of entry.clients) res.end();
  entry.clients.clear();
  entry.server.close();
  entry.server.closeAllConnections();
}

// --------------------------------------------------------------- the page

interface PagePlan {
  ok: true;
  /** The folder's own index.html, served as it is. Null when it has none. */
  ownPage: boolean;
  entry: string | null;
  module: boolean;
  phaserAccess: "module" | "global";
  phaser: { umd: string; esm: string | null; version: string; whose: "project" | "editor" };
  title: string;
  log: string;
}

async function planPage(root: string): Promise<PagePlan | { ok: false; error: string }> {
  const ownPage = await exists(path.join(root, "index.html"));
  const phaser = await findPhaser(root);
  if (!phaser) return { ok: false, error: "No copy of Phaser to serve the game with. Reinstall Mosaic." };

  const title = path.basename(root);
  if (ownPage) {
    return {
      ok: true,
      ownPage,
      entry: null,
      module: false,
      phaserAccess: "global",
      phaser,
      title,
      log: `Serving ${title} as it is, from its own index.html.\n`,
    };
  }

  const existing = await inspectExisting(root);
  const entries = existing?.entries ?? (await findGameEntries(root));
  const entry = entries.find((rel) => /\.m?js$/.test(rel)) ?? null;
  if (!entry) {
    return {
      ok: false,
      error: entries.length
        ? `This folder has no package.json, and ${entries[0]} needs one to build it before a browser can run it.`
        : "This folder has no package.json and no index.html, and no file in it starts a Phaser.Game.",
    };
  }
  const source = (await fs.readFile(path.join(root, entry), "utf8").catch(() => "")) ?? "";
  const module = /^\s*(?:import\s*[\w{*"']|export\s)/m.test(source);
  const phaserAccess = existing?.phaserAccess ?? "global";
  return {
    ok: true,
    ownPage,
    entry,
    module,
    phaserAccess,
    phaser,
    title,
    log:
      `Serving ${title} as it is: no package.json, so no dev server to run.\n` +
      `The page loads Phaser ${phaser.version} (${phaser.whose === "project" ? "the project's own copy" : "Mosaic's copy"}) ` +
      `${phaserAccess === "module" ? "as the module \"phaser\"" : "as the global Phaser"}, ` +
      `then ${entry}${module ? " as a module" : ""}.\n`,
  };
}

/**
 * The page the examples site would show: Phaser, then the file that starts the
 * game. A game whose modules import "phaser" gets it through an import map,
 * which is what a bare specifier means to a browser.
 */
function pageFor(plan: PagePlan): string {
  const src = "/" + (plan.entry ?? "").split("/").map(encodeURIComponent).join("/");
  const phaser =
    plan.phaserAccess === "module" && plan.phaser.esm
      ? `<script type="importmap">{"imports":{"phaser":"${PREFIX}phaser.esm.js"}}</script>`
      : `<script src="${PREFIX}phaser.js"></script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>
html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}
body{display:flex;align-items:center;justify-content:center}
/* A game that sets no scale mode is drawn at its own size; the page fits it to
   the window without changing its config. Phaser reads the canvas's on-screen
   bounds for input, so pointer positions stay right. */
canvas{width:auto!important;height:auto!important;max-width:100vw;max-height:100vh}
</style>
</head>
<body>
${phaser}
<script${plan.module ? ' type="module"' : ""} src="${src}"></script>
${RELOAD}
</body>
</html>
`;
}

/** What makes the page follow saves: the one thing a dev server adds. */
const RELOAD = `<script>new EventSource("${PREFIX}reload").onmessage = () => location.reload();</script>`;

async function handle(
  root: string,
  plan: PagePlan,
  clients: Set<http.ServerResponse>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (rel === `${PREFIX}reload`) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (rel === `${PREFIX}phaser.js`) return sendFile(res, plan.phaser.umd);
  if (rel === `${PREFIX}phaser.esm.js` && plan.phaser.esm) return sendFile(res, plan.phaser.esm);

  if (rel === "/" || rel === "/index.html") {
    if (!plan.ownPage) return send(res, 200, TYPES[".html"], pageFor(plan));
    // The folder's own page, with the reload hook added on the way out. The
    // file on disk is not touched.
    const html = await fs.readFile(path.join(root, "index.html"), "utf8");
    const withReload = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${RELOAD}\n</body>`) : html + RELOAD;
    return send(res, 200, TYPES[".html"], withReload);
  }

  // Everything else is the folder, and nothing outside it.
  const abs = path.resolve(root, "." + rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let target = abs;
  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) target = path.join(abs, "index.html");
  return sendFile(res, target);
}

async function sendFile(res: http.ServerResponse, abs: string): Promise<void> {
  const body = await fs.readFile(abs).catch(() => null);
  if (!body) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  send(res, 200, TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream", body);
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  // No caching: the editor rewrites these files, and a reload has to see it.
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// --------------------------------------------------------------- reloading

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build)([\\/]|$)/;

function watchForReload(root: string, clients: Set<http.ServerResponse>): FSWatcher | null {
  let timer: NodeJS.Timeout | null = null;
  try {
    // A save writes a scene's data and its layout together; one reload covers both.
    return watch(root, { recursive: true }, (_event, file) => {
      if (file && IGNORED.test(String(file))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const res of clients) res.write("data: reload\n\n");
      }, 150);
    });
  } catch {
    // Without a watcher the page still runs; it just needs ↻ after a save.
    return null;
  }
}

// --------------------------------------------------------------- Phaser

const require_ = createRequire(import.meta.url);

/**
 * The project's own Phaser when it has one installed, Mosaic's otherwise —
 * the same order Export uses, and the same copy the import already ran the
 * game against.
 */
async function findPhaser(root: string): Promise<PagePlan["phaser"] | null> {
  const own = await phaserIn(path.join(root, "node_modules", "phaser"));
  if (own) return { ...own, whose: "project" };
  try {
    const dir = path.dirname(require_.resolve("phaser/package.json"));
    const editor = await phaserIn(dir);
    if (editor) return { ...editor, whose: "editor" };
  } catch {
    // Fall through.
  }
  return null;
}

async function phaserIn(dir: string): Promise<Omit<PagePlan["phaser"], "whose"> | null> {
  const umd = path.join(dir, "dist", "phaser.js");
  if (!(await exists(umd))) return null;
  const esm = path.join(dir, "dist", "phaser.esm.js");
  let version = "unknown";
  try {
    version = (JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { version?: string })
      .version ?? version;
  } catch {
    // A copy with no readable manifest still runs.
  }
  return { umd, esm: (await exists(esm)) ? esm : null, version };
}

// --------------------------------------------------------------- CORS

let allowing = false;

/**
 * Lets a served game read the art it loads from another site.
 *
 * Phaser's own examples load their art from a CDN that only answers its own
 * origins, so on 127.0.0.1 every texture comes back missing — the game is
 * fine, the page it runs in is the "wrong" one. Only requests made by a page
 * this file serves are touched, and only to say the page may read the reply.
 * Phaser's loader sends no credentials, so nothing private is exposed.
 */
function allowCrossOriginArt(): void {
  if (allowing) return;
  allowing = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const from = details.referrer ? safeOrigin(details.referrer) : null;
    const ours = from !== null && [...serving.values()].some((s) => s.origin === from);
    if (!ours || safeOrigin(details.url) === from) {
      callback({});
      return;
    }
    const headers: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (!/^access-control-allow-origin$/i.test(name)) headers[name] = value;
    }
    headers["Access-Control-Allow-Origin"] = ["*"];
    callback({ responseHeaders: headers });
  });
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- helpers

async function exists(abs: string): Promise<boolean> {
  return fs
    .access(abs)
    .then(() => true)
    .catch(() => false);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
