import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { app } from "electron";
import { rolldown } from "rolldown";
import type { PackageRequest, PackageResult, PackagedFile, PhaserChoice } from "./contract";

/**
 * Packages a project into a folder you can ship.
 *
 * Export writes SOURCE — a scene class, prefab classes, JSON. Turning that into
 * something playable meant leaving the editor for a terminal, running an
 * install, and running a bundler, which is a cliff at exactly the moment the
 * game is finished. This is the other half: one folder, index.html first, that
 * runs with nothing installed.
 *
 * It reuses the bundler Mosaic already carries. `bundleScripts` compiles script
 * classes for the play-test and `bundleEntry` compiles a project's own entry to
 * run it; this compiles the whole game for keeps. The difference that matters is
 * Phaser: those two deliberately leave it EXTERNAL, because the editor already
 * has an instance and a second copy would break every `instanceof`. A shipped
 * build has no editor to borrow from, so here Phaser is linked in.
 */

/** Written into every build folder, and the only thing that licenses a wipe. */
const MARKER = ".mosaic-build";
const PHASER_ID = "\0mosaic:phaser";

export async function packageGame(request: PackageRequest): Promise<PackageResult> {
  const started = Date.now();
  const warnings: string[] = [];
  try {
    const outDir = await prepareOutDir(request.root, request.outDir);
    const phaser = await findPhaser(request.root);
    const code = await bundle(request, phaser, warnings);

    await fs.writeFile(path.join(outDir, "game.js"), code, "utf8");
    await fs.writeFile(path.join(outDir, "index.html"), await page(request), "utf8");

    if (request.copyAssets) {
      const from = path.resolve(request.root, request.assetsDir);
      if (existsSync(from) && inside(request.root, from)) {
        await fs.cp(from, path.join(outDir, request.assetsDir), { recursive: true });
      } else if (!existsSync(from)) {
        warnings.push(`No ${request.assetsDir}/ folder to copy — the build has no art in it.`);
      }
    }

    const files = await listFiles(outDir);
    let zipPath: string | undefined;
    if (request.zip) {
      zipPath = `${outDir}.zip`;
      // index.html sits at the ROOT of the archive, which is what the web
      // hosts that take a zip (itch.io among them) require.
      await zipDir(outDir, zipPath);
    }

    return {
      ok: true,
      outDir,
      zipPath,
      ms: Date.now() - started,
      warnings,
      files,
      phaser,
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  } catch (err) {
    return {
      ok: false,
      error: clean(err instanceof Error ? err.message : String(err)),
      ms: Date.now() - started,
      warnings,
      files: [],
      totalBytes: 0,
    };
  }
}

// --------------------------------------------------------------- the bundle

async function bundle(
  request: PackageRequest,
  phaser: PhaserChoice,
  warnings: string[],
): Promise<string> {
  const entry = path.resolve(request.root, request.entry);
  if (!inside(request.root, entry)) throw new Error(`${request.entry} is outside the project.`);
  if (!existsSync(entry)) throw new Error(`${request.entry} does not exist.`);

  const build = await rolldown({
    input: { game: entry },
    cwd: request.root,
    platform: "browser",
    // `@property` is the whole point of the script format, and legacy
    // decorators are what the scaffold's tsconfig configures.
    transform: { decorator: { legacy: true } },
    onLog(level, log) {
      // Expected, and alarming to read in a build report: we set legacy
      // decorators deliberately, which is exactly what the project's own
      // tsconfig asks for.
      if (log.code === "CONFIGURATION_FIELD_CONFLICT") return;
      if (level === "warn") warnings.push(clean(log.message ?? String(log)));
    },
    plugins: [
      {
        name: "mosaic:phaser",
        // Handed over as SOURCE rather than as a path. Mosaic's own copy lives
        // inside the app bundle, which on a packaged build is an asar archive —
        // transparent to Node's fs and not to the bundler's own file reads.
        resolveId: (source: string) => (source === "phaser" ? PHASER_ID : null),
        load: (id: string) => (id === PHASER_ID ? fs.readFile(phaser.file, "utf8") : null),
      },
    ],
  });

  const { output } = await build.generate({
    // An IIFE, so the page needs no module server and the folder opens from a
    // plain file path as readily as from a host.
    format: "iife",
    name: "MosaicGame",
    sourcemap: false,
    minify: request.minify,
  });
  await build.close();

  const chunk = output.find((o) => o.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("the bundler produced no output");
  return chunk.code;
}

// --------------------------------------------------------------- the page

async function page(request: PackageRequest): Promise<string> {
  const own = path.join(request.root, "index.html");
  if (existsSync(own)) {
    const html = await fs.readFile(own, "utf8");
    // The project's own page, kept: its title, its styles, its container div.
    // Only the dev server's module entry is swapped for the built bundle.
    const swapped = html.replace(
      /<script\b[^>]*\bsrc=(["'])[^"']*\1[^>]*>\s*<\/script>/i,
      '<script src="./game.js"></script>',
    );
    if (swapped !== html) return swapped;
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, '    <script src="./game.js"></script>\n  </body>');
    }
  }
  return defaultPage(request.title, request.background);
}

function defaultPage(title: string, background: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body { margin: 0; height: 100%; background: ${escapeHtml(background)}; }
      body { display: grid; place-items: center; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <script src="./game.js"></script>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// --------------------------------------------------------------- Phaser

/**
 * The project's own Phaser if it has one, and Mosaic's otherwise.
 *
 * Preferring the project's copy matters: a game pinned to a particular Phaser
 * should ship against that one, not against whatever the editor happens to
 * carry. Falling back to the editor's is what lets a project that has never
 * had `npm install` run against it build anyway.
 */
async function findPhaser(root: string): Promise<PhaserChoice> {
  const own = await phaserAt(path.join(root, "node_modules", "phaser"));
  if (own) return { ...own, source: "project" };

  for (const dir of editorPhaserDirs()) {
    const found = await phaserAt(dir);
    if (found) return { ...found, source: "editor" };
  }
  throw new Error(
    "No copy of Phaser to link in. Run `npm install` in the project, or reinstall Mosaic.",
  );
}

function editorPhaserDirs(): string[] {
  const dirs = [path.join(app.getAppPath(), "node_modules", "phaser")];
  try {
    const require = createRequire(import.meta.url);
    dirs.push(path.dirname(require.resolve("phaser/package.json")));
  } catch {
    // Not resolvable from here in every build layout; getAppPath covers it.
  }
  return dirs;
}

async function phaserAt(dir: string): Promise<Omit<PhaserChoice, "source"> | null> {
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const pkg = JSON.parse(await fs.readFile(manifest, "utf8")) as {
      version?: string;
      module?: string;
      main?: string;
      exports?: { "."?: { import?: string; default?: string } };
    };
    // ESM first: the bundler is linking this into a browser bundle, and the
    // CommonJS build would drag a module shim in with it.
    const rel = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.exports?.["."]?.default ?? pkg.main;
    if (!rel) return null;
    const file = path.resolve(dir, rel);
    if (!existsSync(file)) return null;
    return { file, version: pkg.version ?? "unknown" };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- the folder

/**
 * Makes the output folder, and refuses to be the reason someone loses work.
 *
 * Building is destructive — a stale file from a previous build has to go, or
 * the folder is not the build. So the wipe is licensed narrowly: the path has
 * to be inside the project, it cannot be the project or any folder the project
 * keeps its own files in, and if it already has contents they have to be ours.
 */
async function prepareOutDir(root: string, outRel: string): Promise<string> {
  const abs = path.resolve(root, outRel);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("The build folder has to be inside the project.");
  }
  const first = rel.split(path.sep)[0];
  if (["src", "assets", "node_modules", ".git"].includes(first)) {
    throw new Error(`Refusing to build into ${first}/ — pick a folder of its own, like build/web.`);
  }

  if (existsSync(abs)) {
    const entries = await fs.readdir(abs);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(
        `${rel} already has files in it that Mosaic did not put there. ` +
          `Choose an empty folder, or clear that one yourself.`,
      );
    }
    await fs.rm(abs, { recursive: true, force: true });
  }
  await fs.mkdir(abs, { recursive: true });
  await fs.writeFile(
    path.join(abs, MARKER),
    "Written by Mosaic's Export game. Everything in this folder is rebuilt each time.\n",
    "utf8",
  );
  return abs;
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function listFiles(dir: string): Promise<PackagedFile[]> {
  const out: PackagedFile[] = [];
  const walk = async (abs: string): Promise<void> => {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name !== MARKER) {
        out.push({
          rel: path.relative(dir, child).split(path.sep).join("/"),
          bytes: (await fs.stat(child)).size,
        });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => b.bytes - a.bytes);
}

// --------------------------------------------------------------- the zip

/**
 * A zip, written by hand.
 *
 * The format is small enough to emit directly, and doing so keeps a packaging
 * dependency out of an app whose whole pitch is that your game does not need
 * one. Stored or deflated per file, whichever is smaller.
 */
async function zipDir(dir: string, zipPath: string): Promise<void> {
  const files = (await listFiles(dir)).map((f) => f.rel).sort();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  // A fixed timestamp: two builds of the same game should differ only where
  // the game does. 2024-01-01, as DOS date bits.
  const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

  for (const rel of files) {
    const data = await fs.readFile(path.join(dir, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(data);
    const name = Buffer.from(rel, "utf8");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  await fs.writeFile(zipPath, Buffer.concat([...local, directory, end]));
}

let TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function clean(raw: string): string {
  // Rolldown's diagnostics carry ANSI colour and the whole frame; the dialog
  // shows a few readable lines and keeps the rest for the console.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\[[0-9;]*m/g, "").split("\n").slice(0, 6).join("\n").trim();
}
