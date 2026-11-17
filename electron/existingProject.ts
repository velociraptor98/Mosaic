import fs from "node:fs/promises";
import path from "node:path";
import type { ExistingProject } from "./contract";
import { readIfExists, toPosix, type Paths } from "./projectFiles";

/**
 * What a folder Mosaic has never written to already is.
 *
 * Opening somebody's Phaser game used to show Mosaic's own starter scene over
 * it, and the first save dropped a platformer's worth of prefabs into their
 * repo. The editor cannot do better than that without first knowing three
 * things about the folder, and all three are on disk:
 *
 * - **Which Phaser.** Mosaic writes Phaser 3+ code. A Phaser 2 game has states
 *   rather than scenes and a positional `Game` constructor; nothing Mosaic
 *   generates would run in it, so the honest answer is to say so up front.
 * - **Where the game starts.** The entry the recorder bundles.
 * - **Where its art is, and what URL the game loads it by.** A Vite project
 *   keeps art in `public/assets` and loads it as `assets/…`; Mosaic's own
 *   layout keeps it in `assets/` at the root. Getting this wrong means an
 *   empty asset dock and layouts that 404.
 *
 * Pure Node, like projectFiles.ts, so `npm run check` reads a folder exactly
 * the way the app does.
 */

const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next", "bower_components"]);

interface SourceFile {
  rel: string;
  text: string;
}

/** Every small script in the folder, three levels deep. */
async function readSources(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
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
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(rel, depth + 1);
        continue;
      }
      if (!/\.(m?js|ts)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const stat = await fs.stat(path.join(root, rel)).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      const text = await readIfExists(path.join(root, rel));
      if (text !== null) out.push({ rel, text });
    }
  };
  await walk("", 0);
  return out;
}

/**
 * The names a file can construct a game by.
 *
 * `new Phaser.Game(` is the one the examples use. Phaser's own templates
 * import the class instead — `import { AUTO, Game } from "phaser"` — and call
 * `new Game(`, which on its own would also match a scene that happens to be
 * called Game. So the bare name only counts when the file imported it from
 * Phaser, under whatever alias it chose.
 */
function constructsGame(text: string): boolean {
  if (/new\s+Phaser\s*\.\s*Game\s*\(/.test(text)) return true;
  const named = /import\s*\{([^}]*)\}\s*from\s*["']phaser["']/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(text))) {
    for (const part of m[1].split(",")) {
      const alias = /^\s*Game(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (!alias) continue;
      const local = alias[1] ?? "Game";
      if (new RegExp(`new\\s+${local.replace(/\$/g, "\\$")}\\s*\\(`).test(text)) return true;
    }
  }
  return false;
}

/** The module script index.html starts, which is what a Vite project runs. */
async function htmlEntry(root: string): Promise<string | null> {
  const html = await readIfExists(path.join(root, "index.html"));
  if (!html) return null;
  const m = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html);
  if (!m) return null;
  const rel = m[1].replace(/^\.?\//, "");
  if (!/\.(m?js|ts)$/.test(rel)) return null;
  try {
    await fs.access(path.join(root, rel));
    return toPosix(rel);
  } catch {
    return null;
  }
}

/**
 * Files that start a game, best first.
 *
 * index.html's module script leads when there is one: Phaser's own templates
 * construct the game in `src/game/main.ts` but only from `src/main.ts`, once
 * the DOM is ready. Bundling the first runs a module that exports a function
 * and never calls it. Then anything that constructs a game, conventional names
 * first, shallowest, alphabetical — the caller offers the first as the default.
 */
export async function findGameEntries(root: string): Promise<string[]> {
  const sources = await readSources(root);
  const out = sources.filter((s) => constructsGame(s.text)).map((s) => s.rel);

  const rank = (rel: string): number => {
    const base = rel.split("/").pop() ?? rel;
    const stem = base.replace(/\.\w+$/, "").toLowerCase();
    if (stem === "main") return 0;
    if (stem === "index") return 1;
    if (stem === "game") return 2;
    return 3;
  };
  out.sort(
    (a, b) =>
      rank(a) - rank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b),
  );

  const html = await htmlEntry(root);
  if (html && out.length) return [html, ...out.filter((rel) => rel !== html)];
  return out;
}

/** The Phaser a folder declares, and where it declared it. */
async function declaredPhaser(
  root: string,
): Promise<{ range: string | null; from: ExistingProject["phaserFrom"] }> {
  const pkg = await readIfExists(path.join(root, "package.json"));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
      const range = parsed.dependencies?.phaser ?? parsed.devDependencies?.phaser ?? null;
      if (range) return { range, from: "package.json" };
    } catch {
      // A broken package.json says nothing either way; fall through.
    }
  }
  const bower = await readIfExists(path.join(root, "bower.json"));
  if (bower) {
    try {
      const range = (JSON.parse(bower) as { dependencies?: Record<string, string> }).dependencies?.phaser;
      if (range) return { range, from: "bower.json" };
    } catch {
      // As above.
    }
  }
  return { range: null, from: null };
}

/** "^3.90.0" → 3, "~2.6" → 2, "latest" → null. */
function majorOf(range: string | null): number | null {
  const m = range ? /(\d+)/.exec(range) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Phaser 2 and Phaser 3 are told apart by their code when nothing declares a
 * version, which is common: a game that loads Phaser from a CDN script tag has
 * no manifest that mentions it.
 */
function majorFromCode(sources: SourceFile[]): number | null {
  let v2 = 0;
  let v3 = 0;
  for (const { text } of sources) {
    if (/new\s+Phaser\s*\.\s*Game\s*\(\s*[\d'"]/.test(text)) v2 += 1;
    if (/\.state\s*\.\s*(add|start)\s*\(/.test(text)) v2 += 1;
    if (/extends\s+(Phaser\s*\.\s*)?Scene\b/.test(text)) v3 += 1;
    if (/new\s+Phaser\s*\.\s*Game\s*\(\s*\{/.test(text)) v3 += 1;
  }
  if (v3 > v2) return 3;
  if (v2 > v3) return 2;
  return null;
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the art is, and the folder the game's server serves as `/`.
 *
 * Vite serves `public/` at the root, so a file at `public/assets/star.png` is
 * loaded as `assets/star.png`, and a layout has to say the second. Projects
 * without a public folder serve the project root itself.
 */
async function artLayout(root: string): Promise<{ assets: string; publicDir: string } | null> {
  if (await isDir(path.join(root, "public"))) {
    if (await isDir(path.join(root, "public", "assets"))) return { assets: "public/assets", publicDir: "public" };
    return { assets: "public", publicDir: "public" };
  }
  for (const dir of ["assets", "static/assets", "src/assets"]) {
    if (await isDir(path.join(root, dir))) return { assets: dir, publicDir: "" };
  }
  return null;
}

/** The files most likely to hold the game config: entries first, then anything that builds one. */
function configSources(sources: SourceFile[], entries: string[]): SourceFile[] {
  const ordered = [
    ...entries.map((rel) => sources.find((s) => s.rel === rel)).filter((s): s is SourceFile => !!s),
    ...sources,
  ];
  return ordered.filter(({ text }) => constructsGame(text) || /GameConfig/.test(text));
}

/** `backgroundColor: "#2e91f3"`, `'#fff'` or `0x2e91f3`, as #rrggbb. */
function colourFrom(text: string): string | null {
  const m = /\bbackgroundColor\s*:\s*(?:["'](#[0-9a-f]{3}|#[0-9a-f]{6})["']|0x([0-9a-f]{6}))/i.exec(text);
  if (!m) return null;
  if (m[2]) return `#${m[2].toLowerCase()}`;
  const hex = m[1].toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** What a game config asks for, when it says so literally. */
function configFrom(
  sources: SourceFile[],
  entries: string[],
): Pick<ExistingProject, "canvas" | "physics" | "pixelArt" | "backgroundColor"> {
  const files = configSources(sources, entries);
  let canvas: ExistingProject["canvas"] = null;
  for (const { text } of files) {
    const w = /\bwidth\s*:\s*(\d{2,5})\b/.exec(text);
    const h = /\bheight\s*:\s*(\d{2,5})\b/.exec(text);
    if (w && h) {
      canvas = { width: Number(w[1]), height: Number(h[1]) };
      break;
    }
  }
  const all = files.map((f) => f.text).join("\n");
  const engine = /\bdefault\s*:\s*["'](arcade|matter)["']/.exec(all)?.[1] as "arcade" | "matter" | undefined;
  return {
    canvas,
    physics: engine ?? "none",
    pixelArt: /\bpixelArt\s*:\s*true\b/.test(all),
    backgroundColor: colourFrom(all),
  };
}

/**
 * Reads a folder that holds a game Mosaic did not make. Null when the folder
 * shows no sign of Phaser at all — an empty folder, or somebody's unrelated
 * code — and the caller treats it as it always has.
 */
export async function inspectExisting(root: string): Promise<ExistingProject | null> {
  const sources = await readSources(root);
  const { range, from } = await declaredPhaser(root);
  const usesPhaser =
    !!range || sources.some((s) => /\bPhaser\b|from\s+["']phaser["']/.test(s.text));
  if (!usesPhaser) return null;

  const entries = await findGameEntries(root);
  const art = await artLayout(root);
  const paths: Partial<Paths> & { publicDir?: string } = {};
  if (art) {
    paths.assets = art.assets;
    if (art.publicDir) paths.publicDir = art.publicDir;
  }
  // A project that keeps its code in src/ is indexed from there; one that
  // keeps it loose at the root, as the examples do, from the root.
  if (!(await isDir(path.join(root, "src")))) paths.src = ".";

  return {
    phaser: range,
    phaserFrom: from,
    major: majorOf(range) ?? majorFromCode(sources),
    entries,
    paths,
    ...configFrom(sources, entries),
    // A layout is imported by the class beside it, so it is written in what
    // the class is written in. The file that starts the game says which.
    // A game where no file imports Phaser has it from a script tag, as a
    // global, and runs its modules as the browser loads them.
    phaserAccess: sources.some((s) => /from\s*["']phaser["']|require\(\s*["']phaser["']\s*\)/.test(s.text))
      ? "module"
      : "global",
    language: entries[0]
      ? /\.m?js$/.test(entries[0]) ? "js" : "ts"
      : sources.some((s) => s.rel.endsWith(".ts")) ? "ts" : "js",
  };
}
